package config

import (
	"encoding/json"
	"io/ioutil"
	"log"
	"os"
	"os/user"
	"path/filepath"
)

// Config defines an application
// configuration file structure.
type Config struct {
	ListenAddress string `json:"listenAddress"`
	DataRoot      string `json:"dataRoot"`
}

// CFG is a global config variable;
// it is initalized with the default parameters
var CFG = &Config{
	ListenAddress: ":8080",
	DataRoot:      "./data",
}

func applyConfigFile(filename string) error {
	_, err := os.Stat(filename)
	if os.IsNotExist(err) {
		log.Printf("Config file %s not found", filename)
		return nil
	}
	log.Printf("Applying configuration from %s", filename)

	bytes, err := ioutil.ReadFile(filename)
	if err != nil {
		return err
	}

	err = json.Unmarshal(bytes, &CFG)
	if err != nil {
		return err
	}

	// check if the config file had `dataRoot` set,
	// and if it did, resolve it relative
	// to the config file directory itself
	tmpCfg := &Config{}
	_ = json.Unmarshal(bytes, &tmpCfg)
	if tmpCfg.DataRoot != "" && !filepath.IsAbs(tmpCfg.DataRoot) {
		CFG.DataRoot = filepath.Clean(filepath.Join(filepath.Dir(filename), tmpCfg.DataRoot))
	}

	return nil
}

// Load loads all the application configs
func Load() {
	appPath, err := os.Executable()
	if err != nil {
		log.Fatal("Failed to determine the path to the executable")
	}
	appDir := filepath.Dir(appPath)

	user, err := user.Current()
	if err != nil {
		log.Fatal("Failed to get current user info")
	}

	applyConfigFile(filepath.Join(appDir, "config.json"))
	applyConfigFile(filepath.Join(user.HomeDir, ".figma-preview-server/config.json"))
}
