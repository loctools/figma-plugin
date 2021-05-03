#!/bin/sh

. ./env.local

echo "Running scanAssets command on the local Figma server"
curl -XPOST "$FIGMA_SERVER/api?action=scanAssets"
echo ""
echo ""
