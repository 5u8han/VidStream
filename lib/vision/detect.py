#!/usr/bin/env python3
"""
Detects face and cat presence in an image using OpenCV's bundled Haar
cascades (shipped inside the opencv-python package -- no separate model
download needed). Deliberately scoped to whole-face / whole-animal
presence detection for library organization ("photos with people",
"photos with pets"), not fine-grained body-region analysis.

Usage: python3 detect.py <image_path>
Output: one line of JSON: {"faceCount": N, "hasFace": bool, "hasCat": bool}
"""
import sys
import json

def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "usage: detect.py <image_path>"}))
        sys.exit(1)

    try:
        import cv2
    except ImportError:
        print(json.dumps({"error": "opencv not installed"}))
        sys.exit(1)

    path = sys.argv[1]
    img = cv2.imread(path)
    if img is None:
        print(json.dumps({"error": "could not read image"}))
        sys.exit(1)

    # Downscale before detection -- Haar cascades run on pixel windows,
    # so a huge source image just means more work for no accuracy gain
    # at this scale. 800px on the long edge is plenty.
    h, w = img.shape[:2]
    longest = max(h, w)
    if longest > 800:
        scale = 800.0 / longest
        img = cv2.resize(img, (int(w * scale), int(h * scale)))

    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    gray = cv2.equalizeHist(gray)

    face_cascade = cv2.CascadeClassifier(cv2.data.haarcascades + 'haarcascade_frontalface_default.xml')
    faces = face_cascade.detectMultiScale(gray, scaleFactor=1.1, minNeighbors=6, minSize=(40, 40))

    profile_cascade = cv2.CascadeClassifier(cv2.data.haarcascades + 'haarcascade_profileface.xml')
    profiles = profile_cascade.detectMultiScale(gray, scaleFactor=1.1, minNeighbors=6, minSize=(40, 40))

    cat_cascade = cv2.CascadeClassifier(cv2.data.haarcascades + 'haarcascade_frontalcatface_extended.xml')
    cats = cat_cascade.detectMultiScale(gray, scaleFactor=1.1, minNeighbors=8, minSize=(60, 60))

    face_count = len(faces) + len(profiles)
    print(json.dumps({
        "faceCount": int(face_count),
        "hasFace": face_count > 0,
        "hasCat": len(cats) > 0,
    }))

if __name__ == '__main__':
    main()
