#!/bin/bash
# Tes produksi: upload mp3 1-20MB ke /api/project-files (alur sama persis editor Clincoo)
set -u
BASE="https://app.clincoo.buzz"
UA="Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/128 Mobile Safari/537.36"
EMAIL="tes-upload-mp3-$(date +%s)@clincoo.buzz"
PASS="TesUpload123!"

echo "== 1. Registrasi akun tes =="
REG=$(curl -s --max-time 30 -X POST "$BASE/api/auth/register" \
  -H "Content-Type: application/json" -H "Origin: $BASE" -A "$UA" \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASS\",\"name\":\"Tes Upload\"}")
TOKEN=$(echo "$REG" | python3 -c "import json,sys; print(json.load(sys.stdin).get('token',''))" 2>/dev/null)
if [ -z "$TOKEN" ]; then echo "GAGAL register: $REG"; exit 1; fi
echo "token OK (${#TOKEN} char)"

echo "== 2. Buat proyek tes =="
PID="test-upload-$(date +%s)"
curl -s --max-time 30 -X POST "$BASE/api/projects" -H "Content-Type: application/json" -A "$UA" \
  -H "Authorization: Bearer $TOKEN" \
  -d "{\"project\":{\"id\":\"$PID\",\"title\":\"tes upload mp3 (auto)\",\"prompt\":\"tes\"}}" | head -c 200; echo

echo "== 3. Upload mp3 1/5/10/18/20 MB =="
for MB in 1 5 10 18 20; do
  python3 - "$MB" <<'PYEOF'
import base64, hashlib, json, os, sys, time
mb = int(sys.argv[1])
# payload mp3: header ID3 + byte acak (server tidak memvalidasi isi media)
raw = b'\xff\xfb\x90\x00' + os.urandom(mb * 1024 * 1024 - 4)
# alur klien: FileReader.readAsDataURL -> project[path] = "data:audio/mpeg;base64,..."
datauri = 'data:audio/mpeg;base64,' + base64.b64encode(raw).decode()
# klien: wsB64EncodeEditor(content) = btoa(unescape(encodeURIComponent(content))) — data URI = ASCII murni
content_b64 = base64.b64encode(datauri.encode()).decode()
body = json.dumps({"project_id": os.environ["PID"], "files": [{"path": f"lagu-{mb}mb.mp3", "content_b64": content_b64}]})
open(f"/tmp/body-{mb}.json", "w").write(body)
open(f"/tmp/hash-{mb}.txt", "w").write(hashlib.sha256(datauri.encode()).hexdigest())
print(f"  {mb}MB: mentah={len(raw)/1048576:.1f}MB dataURI={len(datauri)/1048576:.1f}MB body={len(body)/1048576:.1f}MB")
PYEOF
  PID="$PID"  # no-op biar env konsisten
  T0=$(date +%s)
  RES=$(curl -s --max-time 120 -X POST "$BASE/api/project-files" \
    -H "Content-Type: application/json" -A "$UA" -H "Authorization: Bearer $TOKEN" \
    --data @/tmp/body-$MB.json)
  T1=$(date +%s)
  echo "  respons: $(echo "$RES" | head -c 150) ($((T1-T0))s)"
done

echo "== 4. Verifikasi meta =="
curl -s --max-time 30 "$BASE/api/project-files?project_id=$PID&meta=1" -A "$UA" -H "Authorization: Bearer $TOKEN" \
  | python3 -c "
import json,sys
d = json.load(sys.stdin)
for f in d.get('files', []):
    print(f\"  {f['path']}: size={f.get('size',0)/1048576:.1f}MB is_big={f.get('is_big')}\")"

echo "== 5. Verifikasi isi utuh (round-trip) =="
for MB in 1 5 10 18 20; do
  R=$(curl -s --max-time 60 "$BASE/api/project-files?project_id=$PID&path=lagu-$MB%20mb.mp3&content=1" -A "$UA" -H "Authorization: Bearer $TOKEN" 2>/dev/null)
  # nama path sebenarnya: lagu-{mb}mb.mp3 (tanpa spasi)
  R=$(curl -s --max-time 60 "$BASE/api/project-files?project_id=$PID&path=lagu-${MB}mb.mp3&content=1" -A "$UA" -H "Authorization: Bearer $TOKEN")
  echo "$R" | python3 - "$MB" <<'PYEOF'
import base64, hashlib, json, sys
mb = sys.argv[1]
try:
    d = json.loads(sys.stdin.read() if False else "")  # placeholder
except Exception:
    pass
PYEOF
  echo "$R" | python3 -c "
import base64, hashlib, json, sys
mb = '$MB'
try:
    d = json.load(sys.stdin)
    if d.get('error'): print(f'  {mb}MB: ERROR {d[\"error\"]}'); sys.exit()
    got = base64.b64decode(d['content_b64'])
    want = open(f'/tmp/hash-{mb}.txt').read()
    h = hashlib.sha256(got).hexdigest()
    print(f'  {mb}MB: {\"UTUH — hash cocok\" if h == want else \"RUSAK — hash beda!\"} (panjang {len(got)/1048576:.1f}MB, is_big={d.get(\"is_big\")})')
except Exception as e:
    print(f'  {mb}MB: gagal parse {e}')"
done

echo "== 6. Cleanup =="
curl -s --max-time 60 -X DELETE "$BASE/api/project-files?project_id=$PID" -A "$UA" -H "Authorization: Bearer $TOKEN" | head -c 120; echo
curl -s --max-time 30 -X POST "$BASE/api/projects" -H "Content-Type: application/json" -A "$UA" \
  -H "Authorization: Bearer $TOKEN" -d "{\"action\":\"delete\",\"id\":\"$PID\"}" | head -c 120; echo
echo "selesai"
