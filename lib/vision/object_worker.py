#!/usr/bin/env python3
"""
Long-lived object-detection worker. Loads YOLOv8n once, then reads one
image path per line from stdin and writes one JSON result per line to
stdout. Runs as a persistent child process (see lib/vision-objects.js)
rather than being invoked fresh per photo, since loading PyTorch + the
model takes real time -- paying that on every single image would make
scanning a real library impractically slow.

Protocol (newline-delimited JSON both ways):
  stdin:  {"path": "/abs/path/to/image.jpg"}
  stdout: {"objects": ["person", "dog"]}   on success
          {"error": "..."}                  on failure for that one image

On startup, prints exactly one line -- "READY" or "UNAVAILABLE: <reason>"
-- so the Node side knows whether the worker actually came up before
sending it real work.
"""
import sys
import json
import os

CONFIDENCE_THRESHOLD = 0.45
IMAGE_SIZE = 480  # inference resolution; presence detection doesn't need full-res

def main():
    try:
        from ultralytics import YOLO
    except ImportError:
        print("UNAVAILABLE: ultralytics not installed", flush=True)
        return

    weights_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'yolov8n.pt')
    if not os.path.isfile(weights_path):
        print("UNAVAILABLE: yolov8n.pt not found (ENABLE_OBJECT_DETECTION=false at build time?)", flush=True)
        return

    try:
        model = YOLO(weights_path)
    except Exception as e:
        print(f"UNAVAILABLE: failed to load model: {e}", flush=True)
        return

    print("READY", flush=True)

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            path = req['path']
            results = model(path, imgsz=IMAGE_SIZE, verbose=False)
            names = results[0].names
            detected = set()
            for box in results[0].boxes:
                conf = float(box.conf[0])
                if conf >= CONFIDENCE_THRESHOLD:
                    detected.add(names[int(box.cls[0])])
            print(json.dumps({"objects": sorted(detected)}), flush=True)
        except Exception as e:
            print(json.dumps({"error": str(e)}), flush=True)

if __name__ == '__main__':
    main()
