#!/usr/bin/env bash
# Tiles four review stills into a 2x2 sheet: tile.sh out.jpg a.jpg b.jpg c.jpg d.jpg
set -euo pipefail
out="$1"
shift
/usr/local/bin/ffmpeg -v error -y -i "$1" -i "$2" -i "$3" -i "$4" \
  -filter_complex "[0:v][1:v][2:v][3:v]xstack=inputs=4:layout=0_0|w0_0|0_h0|w0_h0[v]" \
  -map "[v]" -frames:v 1 "$out"
