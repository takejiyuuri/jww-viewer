#!/bin/bash
# App Store のプレビュー動画を、iOS シミュレータの画面録画で撮る（Codemagic の Mac で動かす）。
# 先に、自動手順（scenario.js）を入れた撮影用ビルドをシミュレータ向けに作っておくこと。
#   SHOT_DEVICE : シミュレータの機種名（既定「iPhone 16 Plus」）
#   SHOT_LABEL  : 出力のフォルダ名と動画の名前（既定 iphone）
#   SHOT_OUT    : 出力先（既定 videos）
set -uo pipefail

BUNDLE=io.github.takejiyuuri.mitehakaru
APP=${SHOT_APP:-build/derived/Build/Products/Debug-iphonesimulator/App.app}
DEVICE=${SHOT_DEVICE:-iPhone 16 Plus}
LABEL=${SHOT_LABEL:-iphone}
OUT=${SHOT_OUT:-videos}/$LABEL
mkdir -p "$OUT"

xcrun simctl list devices available > "$OUT/simulators.txt"

# 機種名がぴったり同じもの（なければ名前に含むもの）を、いちばん新しい iOS から選ぶ
pick() {
  xcrun simctl list devices available -j | python3 -c '
import json, sys
want = sys.argv[1]
d = json.load(sys.stdin)["devices"]
best = None
for rt, devs in d.items():
    if "iOS" not in rt:
        continue
    ver = [int(x) for x in rt.rsplit("iOS-", 1)[-1].split("-") if x.isdigit()]
    for dev in devs:
        exact = dev["name"] == want
        if (exact or want in dev["name"]) and (best is None or (exact, ver) > (best[4], best[0])):
            best = (ver, dev["udid"], dev["name"], rt, exact)
if best:
    print(best[1]); print(best[2] + " / " + best[3], file=sys.stderr)
' "$1"
}
UDID=$(pick "$DEVICE")
[ -z "$UDID" ] && [ "$DEVICE" = "iPad Pro 13-inch" ] && UDID=$(pick "iPad Air 13-inch")
if [ -z "$UDID" ]; then
  TYPE=$(xcrun simctl list devicetypes -j | python3 -c 'import json,sys; a=json.load(sys.stdin)["devicetypes"]; t=[x for x in a if x["name"]==sys.argv[1]] or [x for x in a if sys.argv[1] in x["name"]]; print(t[-1]["identifier"] if t else "")' "$DEVICE")
  RUNTIME=$(xcrun simctl list runtimes -j | python3 -c 'import json,sys; r=[x for x in json.load(sys.stdin)["runtimes"] if x.get("isAvailable") and x["platform"]=="iOS"]; print(r[-1]["identifier"] if r else "")')
  echo "== $DEVICE が無いので作ります: $TYPE / $RUNTIME"
  UDID=$(xcrun simctl create "video-$LABEL" "$TYPE" "$RUNTIME")
fi
[ -z "$UDID" ] && { echo "シミュレータが見つかりません"; exit 1; }
echo "== 使うシミュレータ: $UDID"

xcrun simctl boot "$UDID" 2>/dev/null || true
xcrun simctl bootstatus "$UDID" -b
# 上の時刻の帯を日本語にする（言語と地域を日本にして、もう一度起動し直す）
xcrun simctl spawn "$UDID" defaults write -g AppleLanguages -array ja-JP || true
xcrun simctl spawn "$UDID" defaults write -g AppleLocale -string ja_JP || true
xcrun simctl shutdown "$UDID" || true
xcrun simctl boot "$UDID"
xcrun simctl bootstatus "$UDID" -b
# 上の時刻・電池・電波の表示をそろえる（9:41・満充電）
xcrun simctl status_bar "$UDID" override --time "9:41" --dataNetwork wifi --wifiMode active --wifiBars 3 \
  --batteryState charged --batteryLevel 100 || true
xcrun simctl ui "$UDID" appearance dark || true

# 起動直後に出るお知らせが消えるまで待ってから、アプリを入れる
sleep "${SHOT_SETTLE:-75}"
xcrun simctl install "$UDID" "$APP"
DATA=$(xcrun simctl get_app_container "$UDID" "$BUNDLE" data)
DOCS="$DATA/Documents"
mkdir -p "$DOCS"
rm -f "$DOCS"/shot-*.txt
xcrun simctl launch "$UDID" "$BUNDLE"
sleep 6
xcrun simctl io "$UDID" screenshot --type=png "$OUT/_after_launch.png" || true

# 自動手順の合図で録画を始め・止める。FINISHED / ERROR か、時間切れ（10 分）で終わる
LAST=""
REC_PID=""
END=$((SECONDS + 600))
STATUS=1
START=$SECONDS
while [ $SECONDS -lt $END ]; do
  if [ -z "$LAST" ] && [ $((SECONDS - START)) -gt 240 ]; then echo "== 最初の合図が来ません"; break; fi
  REQ=$(cat "$DOCS/shot-request.txt" 2>/dev/null || true)
  if [ -n "$REQ" ] && [ "$REQ" != "$LAST" ]; then
    LAST=$REQ
    echo "== 合図: $REQ"
    case "$REQ" in
      REC_START)
        xcrun simctl io "$UDID" recordVideo --codec=h264 --force "$OUT/$LABEL.mov" > "$OUT/record.log" 2>&1 &
        REC_PID=$!
        # 録画が動き出すまで待つ
        for _ in $(seq 1 50); do grep -q -i "recording started" "$OUT/record.log" 2>/dev/null && break; sleep 0.1; done
        sleep 0.5
        ;;
      REC_STOP)
        [ -n "$REC_PID" ] && kill -INT "$REC_PID" && wait "$REC_PID"
        REC_PID=""
        ;;
      FINISHED) STATUS=0; echo "== 撮り終わりました"; break ;;
      ERROR) echo "== 自動手順が途中で止まりました"; break ;;
    esac
    printf '%s' "$REQ" > "$DOCS/shot-done.txt"
  fi
  sleep 0.1
done
[ $SECONDS -ge $END ] && echo "== 時間切れ（合図が来ませんでした）"
[ -n "$REC_PID" ] && kill -INT "$REC_PID" && wait "$REC_PID"

xcrun simctl io "$UDID" screenshot --type=png "$OUT/_last.png" || true
cp "$DOCS/shot-log.txt" "$OUT/shot-log.txt" 2>/dev/null || true
cat "$OUT/record.log" 2>/dev/null
echo "== 撮った動画"
ls -la "$OUT"
xcrun simctl shutdown "$UDID" 2>/dev/null || true
[ -s "$OUT/$LABEL.mov" ] || STATUS=1
exit $STATUS
