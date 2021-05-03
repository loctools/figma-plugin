#!/bin/sh

. ./env.local

echo "Running scanLocalizationFiles command on a local Figma server"
curl -XPOST "$FIGMA_SERVER/api?action=scanLocalizationFiles"
echo ""
echo ""
