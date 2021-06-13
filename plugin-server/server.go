package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/ioutil"
	"log"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"
	"sync"

	"golang.org/x/net/websocket"

	"figma-plugin-server/config"
)

const jsonKindAssetsChange = "assetsChange"

var assetsDirName string
var localizationDirName string
var previewDirName string

var ws = &websocket.Server{}
var openSockets = make(map[int]*websocket.Conn)
var socketCounter int = 0
var socketMutex = &sync.Mutex{}

var modTimeCache = make(map[string]int64)

var idleSignalChannel = make(chan bool)

func finalizeConnection(id int) {
	log.Printf("Socket #%d closed", id)
	socketMutex.Lock()
	delete(openSockets, id)
	close(idleSignalChannel)
	idleSignalChannel = make(chan bool)
	socketMutex.Unlock()
	log.Printf("Socket #%d connection cleaned up", id)
}

func wsServer(conn *websocket.Conn) {
	socketMutex.Lock()
	socketCounter++
	id := socketCounter
	openSockets[id] = conn
	defer finalizeConnection(id)
	socketMutex.Unlock()

	log.Printf("Connected socket #%d", id)

	msg := make([]byte, 1000000) // 1MB
	for true {
		n, err := conn.Read(msg)
		if err != nil {
			if err != io.EOF {
				log.Printf("Socket #%d read error: %v", id, err)
			}
			return
		}

		if n < 200 {
			log.Printf("%d bytes read from socket #%d: %s", n, id, string(msg[:n]))
		} else {
			log.Printf("%d bytes read from socket #%d: %s<...>", n, id, string(msg[:50]))
		}

		if string(msg[:n]) == "idle" {
			go func() {
				idleSignalChannel <- true
			}()
		}
	}
}

func prepareResponse(err error) []byte {
	if err == nil {
		return []byte("{\"status\":\"ok\"}")
	}

	status := struct {
		Status  string `json:"status"`
		Message string `json:"message"`
	}{
		Status:  "error",
		Message: err.Error(),
	}
	out, err := json.Marshal(status)
	if err != nil {
		log.Printf("Error while marshalling JSON: %s", err)
		return []byte("{\"status\":\"error\",\"message\":\"internal error\"}")
	}
	return out
}

func writeResponse(w http.ResponseWriter, err error) {
	_, err = w.Write(prepareResponse(err))
	if err != nil {
		log.Printf("Error while writing response: %s", err)
	}
}

func wsBroadcast(msg []byte) error {
	for id, conn := range openSockets {
		n, err := conn.Write(msg)
		if err != nil {
			log.Printf("Failed to write to socket #%d: %v", id, err)
			return err
		}
		log.Printf("%d bytes written to socket #%d", n, id)
	}
	return nil
}

func apiHandler(w http.ResponseWriter, req *http.Request) {
	writeResponse(w, apiHandlerInternal(w, req))
}

func apiHandlerInternal(w http.ResponseWriter, req *http.Request) (err error) {
	log.Println("Running API Handler")

	err = req.ParseForm()
	if err != nil {
		fmt.Fprintf(w, "Failed to parse form: %v", err)
		return
	}

	switch req.FormValue("action") {
	case "scanAssets":
		err = scanAssets(req.FormValue("force") == "1")
		if err != nil {
			return
		}
		waitForIdleSignal()
	case "scanLocalizationFiles":
		err = scanLocalizationFiles(false, req.FormValue("force") == "1")
		if err != nil {
			return
		}
		waitForIdleSignal()
	default:
		err = errors.New("Unsupported action")
		log.Println("err:", err)
	}

	return
}

func waitForIdleSignal() {
	<-idleSignalChannel
	log.Println("Got the idle signal")
}

func uploadHandler(w http.ResponseWriter, req *http.Request) {
	writeResponse(w, uploadHandlerInternal(w, req))
}

func uploadHandlerInternal(w http.ResponseWriter, req *http.Request) (err error) {
	//log.Printf("uploadHandler(). Method: %s. Content length: %d", req.Method, req.ContentLength)

	if req.Method != http.MethodPost {
		log.Printf("Unsupported method: %s", req.Method)
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}

	w.Header().Set("Access-Control-Allow-Origin", "*") // TODO: validate request to avoid CSRF

	formFile, _, err := req.FormFile("file")

	if err != nil {
		log.Printf("Error while getting file: %s", err)
		return
	}

	filename := req.FormValue("filename")
	log.Printf("Got file: %s", filename)
	filename = config.CFG.DataRoot + "/" + filename

	err = os.MkdirAll(path.Dir(filename), 0777)
	if err != nil {
		log.Printf("Error while creating path [%s]: %s", path.Dir(filename), err)
		return
	}

	localFile, err := os.Create(filename)
	if err != nil {
		log.Printf("Error while creating file [%s]: %s", filename, err)
		return
	}
	defer localFile.Close()

	n, err := io.Copy(localFile, formFile)
	if err != nil {
		log.Printf("Error while copying file data: %s", err)
		return
	}
	log.Printf("%d bytes written to file", n)

	// If not a localization file, return
	if !strings.HasPrefix(filename, localizationDirName+"/") {
		return
	}

	// Update cache for localization file
	info, err := os.Stat(filename)
	if err != nil {
		log.Printf("Error while getting file info: %s", err)
		return
	}
	t := info.ModTime().UnixNano()
	log.Printf("Updating modification time for %s", filename)
	modTimeCache[filename] = t

	return
}

func processHandler(w http.ResponseWriter, req *http.Request) {
	writeResponse(w, processHandlerInternal(w, req))
}

func processHandlerInternal(w http.ResponseWriter, req *http.Request) (err error) {
	log.Printf("processHandler(). Method: %s. Content length: %d", req.Method, req.ContentLength)

	if req.Method != http.MethodPost {
		log.Printf("Unsupported method: %s", req.Method)
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}

	w.Header().Set("Access-Control-Allow-Origin", "*") // TODO: validate request to avoid CSRF

	formFile, _, err := req.FormFile("file")
	if err != nil {
		log.Printf("Error while getting file: %s", err)
		return
	}

	kind := req.FormValue("kind")
	log.Printf("JSON kind: %s", kind)

	bytes, err := ioutil.ReadAll(formFile)
	if err != nil {
		log.Printf("Error while reading file data: %s", err)
		return
	}

	err = nil
	switch kind {
	case jsonKindAssetsChange:
		err = processAssetsChange(bytes)
	default:
		err = errors.New("unsupported kind")
	}

	return
}

func processAssetsChange(bytes []byte) error {
	log.Printf("Processing assets change event")
	defer log.Printf("Done processing assets change event")

	var assets []string

	err := json.Unmarshal(bytes, &assets)
	if err != nil {
		return err
	}

	allowedDirsMap := make(map[string]bool)

	for i := 0; i < len(assets); i++ {
		assetDir := assets[i]
		allowedDirsMap[assetDir] = true

		parentDir := assetDir
		for strings.Index(parentDir, "/") > -1 {
			parentDir, _ = path.Split(parentDir)
			parentDir = strings.Trim(parentDir, "/")
			allowedDirsMap[parentDir] = true
		}
	}

	allowedDirs := make([]string, 0, len(allowedDirsMap))
	for key := range allowedDirsMap {
		allowedDirs = append(allowedDirs, key)
	}

	/** /
	fmt.Println("allowedDirs:")
	for _, v := range allowedDirs {
		fmt.Printf("\t%s\n", v)
	}
	/**/

	err = processAssetsChangeForDir(assetsDirName, allowedDirs)
	if err != nil {
		return err
	}

	err = processAssetsChangeForDir(localizationDirName, allowedDirs)
	if err != nil {
		return err
	}

	err = processAssetsChangeForDir(previewDirName, allowedDirs)
	if err != nil {
		return err
	}

	return nil
}

func processAssetsChangeForDir(dir string, allowedDirs []string) error {
	// TODO: convert dir to an absolute path relative to executable
	// or to root dir passed as a parameter?

	existingDirs := make([]string, 0)
	err := filepath.Walk(dir, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if !info.IsDir() || path == dir {
			return nil
		}
		existingDirs = append(existingDirs, path)
		return nil
	})
	if err != nil {
		return err
	}

	//log.Printf("Checking directory: %s", dir)

	/** /
	fmt.Println("existingDirs:")
	for _, v := range existingDirs {
		fmt.Printf("\t%s\n", v)
	}
	/**/
	//return nil // DEBUG

	for j := 0; j < len(existingDirs); j++ {
		d := existingDirs[j]
		found := false

		for i := 0; i < len(allowedDirs); i++ {
			// TODO: convert fullPath to an absolute path?
			fullPath := dir + "/" + allowedDirs[i]
			if d == fullPath {
				found = true
				break
			}
		}

		if !found {
			log.Printf("Deleting directory %s and its contents", d)

			err = os.RemoveAll(d)
			if err != nil {
				return err
			}

			// Note that since we collect all the intermediate directories,
			// this code will take care of removing unused intermediate
			// directories as well
		} else {
			//log.Printf("Path %s matches an existing asset", d)
		}
	}

	return nil
}

func scanAssets(force bool) error {
	envelope := struct {
		Action string `json:"action"`
		Force  bool   `json:"force"`
	}{
		Action: "scanAssets",
		Force:  force,
	}
	bytes, err := json.Marshal(envelope)
	if err != nil {
		return err
	}
	err = wsBroadcast(bytes)
	if err != nil {
		return err
	}

	// TODO: wait for the 'ready' signal from the plugin

	return nil
}

func sendWsAction(action string) error {
	envelope := struct {
		Action string `json:"action"`
	}{
		Action: action,
	}
	bytes, err := json.Marshal(envelope)
	if err != nil {
		return err
	}
	return wsBroadcast(bytes)
}

func scanLocalizationFiles(initialize bool, force bool) error {
	if !initialize && len(openSockets) == 0 {
		log.Println("No clients connected; will skip scanning for changes")
		return nil
	}

	log.Printf("Scanning localization files for changes")
	defer log.Printf("Done scanning localization files for changes")

	err := sendWsAction("startOfFileParsing")
	if err != nil {
		return err
	}

	defer sendWsAction("endOfFileParsing")

	// TODO: convert dir to an absolute path relative to executable
	// or to root dir passed as a parameter?

	err = filepath.Walk(localizationDirName, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}

		if info.IsDir() || !strings.HasSuffix(path, ".json") {
			return nil
		}

		t := info.ModTime().UnixNano()

		if initialize {
			//log.Printf("Registered %s", path)
			modTimeCache[path] = t
			return nil
		}

		if modTimeCache[path] != t {
			log.Printf("File %s has changed", path)
			modTimeCache[path] = t
			return processLocalizationFile(path)
		}

		if force {
			log.Printf("File %s has changed (forced mode)", path)
			return processLocalizationFile(path)
		}

		return nil
	})
	return err
}

func processLocalizationFile(path string) error {
	prefix := localizationDirName + "/"
	if !strings.HasPrefix(path, prefix) {
		return errors.New("Unexpected file path")
	}

	data, err := ioutil.ReadFile(path)
	if err != nil {
		return err
	}

	path = filepath.ToSlash(path) // normalize the file path across operating systems
	path = path[len(prefix):] // remove the prefix

	envelope := struct {
		Action string `json:"action"`
		Path   string `json:"path"`
		Data   string `json:"data"`
	}{
		Action: "parseFile",
		Path:   path,
		Data:   string(data),
	}
	bytes, err := json.Marshal(envelope)
	if err != nil {
		return err
	}
	err = wsBroadcast(bytes)
	if err != nil {
		return err
	}

	// TODO: wait for the 'ready' signal from the plugin

	return nil
}

func main() {
	config.Load()

	assetsDirName = config.CFG.DataRoot + "/assets"
	localizationDirName = config.CFG.DataRoot + "/localization"
	previewDirName = config.CFG.DataRoot + "/preview"

	//fmt.Printf("%+v", config.CFG)

	ws.Handler = wsServer

	http.HandleFunc("/ws", ws.ServeHTTP)
	http.HandleFunc("/api", apiHandler)
	http.HandleFunc("/upload", uploadHandler)
	http.HandleFunc("/process", processHandler)

	scanLocalizationFiles(true, false)

	log.Printf("Listening on %s\n", config.CFG.ListenAddress)
	log.Printf("Root folder: %s\n", config.CFG.DataRoot)
	log.Fatal(http.ListenAndServe(config.CFG.ListenAddress, nil))
}
