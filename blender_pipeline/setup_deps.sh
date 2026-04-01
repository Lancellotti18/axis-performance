#!/usr/bin/env bash
# setup_deps.sh
# Installs required Python packages into Blender's bundled Python.
# Run once after installing Blender 4.x.
#
# Usage:
#   chmod +x setup_deps.sh
#   ./setup_deps.sh /path/to/blender
#
# Example (macOS):
#   ./setup_deps.sh /Applications/Blender.app/Contents/MacOS/Blender
#
# Example (Linux):
#   ./setup_deps.sh /usr/bin/blender

set -e

BLENDER="${1:-blender}"

echo "[SETUP] Installing Python dependencies into Blender's Python..."
echo "[SETUP] Blender binary: $BLENDER"

# Find Blender's Python executable
BPY=$("$BLENDER" --background --python-expr \
    "import sys; print(sys.executable)" 2>/dev/null | tail -1)

if [ -z "$BPY" ]; then
    echo "[ERROR] Could not find Blender's Python. Check BLENDER path."
    exit 1
fi

echo "[SETUP] Blender Python: $BPY"

# Upgrade pip first
"$BPY" -m pip install --upgrade pip

# Install packages
PACKAGES=(
    "opencv-python"
    "PyMuPDF"
    "numpy"
    "Pillow"
    "requests"
)

for pkg in "${PACKAGES[@]}"; do
    echo "[SETUP] Installing: $pkg"
    "$BPY" -m pip install "$pkg" --quiet
done

echo ""
echo "[SETUP] All dependencies installed successfully."
echo "[SETUP] Run the pipeline with:"
echo ""
echo "  $BLENDER --background --python main.py -- blueprint.pdf ./output production"
echo ""
