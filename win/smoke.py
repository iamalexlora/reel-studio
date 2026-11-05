"""Prueba rápida del motor en Windows (la corre GitHub Actions antes de publicar el instalador)."""
import json, os, subprocess, sys, tempfile, time, urllib.request
from pathlib import Path

app = Path(sys.argv[1]).resolve()            # ...\ReelStudio\app
os.environ["REEL_HOME"] = tempfile.mkdtemp()
os.environ.setdefault("REEL_WHISPER_MODEL", "tiny")
sys.path.insert(0, str(app))
import engine as E  # noqa

print("ffmpeg:", E.FFMPEG, "· versión mayor:", E.ffmpeg_major(), "· libx264:", E.has_encoder("libx264"))
assert "runtime" in E.FFMPEG, "debería usar el ffmpeg incluido"

src = Path(os.environ["REEL_HOME"]) / "prueba.mp4"
subprocess.run([E.FFMPEG, "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=1280x720:r=30:d=6",
                "-f", "lavfi", "-i", "sine=f=440:d=6", "-c:v", "libx264", "-pix_fmt", "yuv420p",
                "-c:a", "aac", "-shortest", str(src)], check=True)
p, dest = E.create_project("Prueba Windows", ".mp4")
dest.write_bytes(src.read_bytes())
info = E.probe(dest)
p = E.update(p["id"], lambda q: q.update(info))
E.make_previews(p)

t = time.time()
words = E.transcribe(p, lambda f, m="": None)
print(f"transcripción OK ({p.get('engine')}) en {time.time() - t:.1f}s · {len(words)} palabras")

fake = []
for i, w in enumerate("hola esto es una prueba de reel studio en windows".split()):
    fake.append({"id": i, "text": w, "orig": w, "start": 0.4 + i * 0.5, "end": 0.8 + i * 0.5, "prob": 1,
                 "cut": i == 3, "reason": "", "by": "", "suggest": ""})
def setw(q):
    q["words"] = fake; q["status"] = "listo"
p = E.update(p["id"], setw)
for opts in ({"format": "vertical", "fps": 30, "quality": "liviana"},
             {"format": "horizontal", "fps": 60, "quality": "liviana", "srt": True}):
    r = E.export(E.load(p["id"]), opts)
    out = E.project_dir(p["id"]) / "exports" / r["file"]
    pr = E.probe(out)
    print("export OK:", r["file"], r["size_px"], r["fps"], "fps", f"{pr['duration']:.2f}s")
    assert pr["duration"] > 2

env = dict(os.environ, PYTHONUTF8="1")
srv = subprocess.Popen([sys.executable, "server.py"], cwd=str(app), env=env)
try:
    for _ in range(40):
        try:
            h = json.loads(urllib.request.urlopen("http://127.0.0.1:8765/api/health", timeout=1).read())
            break
        except Exception:
            time.sleep(0.25)
    print("servidor OK:", h)
    html = urllib.request.urlopen("http://127.0.0.1:8765/", timeout=3).read()
    assert b"Reel Studio" in html
    urllib.request.urlopen(urllib.request.Request("http://127.0.0.1:8765/api/shutdown", data=b"", method="POST"), timeout=3)
    srv.wait(timeout=10)
    print("apagado OK")
finally:
    if srv.poll() is None:
        srv.kill()
print("TODO OK")
