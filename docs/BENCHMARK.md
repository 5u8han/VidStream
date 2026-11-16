# Benchmark a VidStream deployment

Sign in, open **Dashboard**, and select the benchmark's run button.
For each server, run it from the browser and network you normally use.
A browser on the web server measures that connection, which can be
substantially faster than a phone on Wi-Fi.

| Measurement | How to read it |
| --- | --- |
| CPU and memory available to the server | Docker or a VM may expose fewer resources than the physical machine. The short CPU sample times a fixed cryptographic calculation. Preview encoding and initial library scans use different work. |
| Host cache capacity and I/O | Free space refers to the filesystem backing the cache. The benchmark writes a small temporary file, flushes it, and reads it back. A recently written read can be served by the operating system's page cache. |
| Browser delivery rate and request latency | The browser times a synthetic transfer from this VidStream server. The result includes the actual network path and browser request overhead. It describes the connection at the time of the test. |

The recommendations are starting points. Use the preview suggestion as a
limit for simultaneous autoplay in the gallery. Confirm it by checking
scrolling and playback on that device. A fast network may still be paired
with a slow video decoder or an overloaded server.

A suggested cache budget leaves spare space for scan growth, SQLite and
other disk use. Any folder allocation is a planning estimate based on the
available catalog. The report does not change settings, enforce folder
quotas or delete cache files. VidStream's `CACHE_MAX_BYTES` option manages
short previews and compatible video copies. Cached original-video ranges
have a separate free-space safeguard. [Cache behavior](PORTABLE_CACHE.md) · [Storage sizing](PERFORMANCE.md#estimate-the-ssd-size)

**Download JSON** exports the measurements and recommendations for comparing
machines. Run the benchmark when the host is idle and once more under
typical load. Media files are never used as test data, and existing catalog
and media content remain in place. The exported JSON uses numbered folders and omits folder names and host addresses. The benchmark runs locally against your
own VidStream server.
