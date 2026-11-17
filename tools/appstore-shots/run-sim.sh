#!/bin/bash
# App Store 用の実画面を、iOS シミュレータで撮る（Codemagic の Mac で動かす。手順は README.md）。
# 先に、自動手順（scenario.js）を入れた撮影用ビルドをシミュレータ向けに作っておくこと。
#   SHOT_DEVICE : シミュレータの機種名の一部（既定「iPad Pro 13-inch」。なければ「iPad Air 13-inch」）
#   SHOT_LABEL  : 出力のフォルダ名と画像の名前の頭（既定 ipad）
#   SHOT_OUT    : 出力先（既定 screenshots）
set -uo pipefail

BUNDLE=io.github.takejiyuuri.mitehakaru
APP=${SHOT_APP:-build/derived/Build/Products/Debug-iphonesimulator/App.app}
DEVICE=${SHOT_DEVICE:-iPad Pro 13-inch}
LABEL=${SHOT_LABEL:-ipad}
OUT=${SHOT_OUT:-screenshots}/$LABEL
mkdir -p "$OUT"

echo "== 使えるシミュレータ"
xcrun simctl list devices available | tee "$OUT/simulators.txt" | grep -i -E "ipad|iphone" | head -40

# 機種名に DEVICE を含むものを選ぶ（いちばん新しい iOS のもの）。なければ「iPad Air 13-inch」、それもなければ作る
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
        # 名前がぴったり同じものを優先する（「iPhone 16」で「iPhone 16 Plus」を選ばないように）
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
  UDID=$(xcrun simctl create "shot-$LABEL" "$TYPE" "$RUNTIME")
fi
[ -z "$UDID" ] && { echo "シミュレータが見つかりません"; exit 1; }
echo "== 使うシミュレータ: $UDID"

xcrun simctl boot "$UDID" 2>/dev/null || true
xcrun simctl bootstatus "$UDID" -b
# 上の時刻の帯を日本語にする（言語と地域を日本にして、もう一度起動し直す）
if [ "${SHOT_LANG:-ja}" = "ja" ]; then
  xcrun simctl spawn "$UDID" defaults write -g AppleLanguages -array ja-JP || true
  xcrun simctl spawn "$UDID" defaults write -g AppleLocale -string ja_JP || true
  xcrun simctl shutdown "$UDID" || true
  xcrun simctl boot "$UDID"
  xcrun simctl bootstatus "$UDID" -b
  echo "== 言語: $(xcrun simctl spawn "$UDID" defaults read -g AppleLanguages | tr -d '\n ')"
fi
# 上の時刻・電池・電波の表示をそろえる（9:41・満充電）
xcrun simctl status_bar "$UDID" override --time "9:41" --dataNetwork wifi --wifiMode active --wifiBars 3 \
  --batteryState charged --batteryLevel 100 || true
xcrun simctl ui "$UDID" appearance dark || true

# 起動直後は iPadOS のお知らせ（Apple Intelligence など）が上に出ることがあるので、消えるまで待ってからアプリを入れる
sleep "${SHOT_SETTLE:-75}"
xcrun simctl install "$UDID" "$APP"
DATA=$(xcrun simctl get_app_container "$UDID" "$BUNDLE" data)
DOCS="$DATA/Documents"
mkdir -p "$DOCS"
rm -f "$DOCS"/shot-*.txt
# 起動のあと少し待ってから、動いているか 1 枚撮っておく（うまくいかなかったときの手がかり）
xcrun simctl launch "$UDID" "$BUNDLE"
sleep 8
xcrun simctl io "$UDID" screenshot --type=png "$OUT/_after_launch.png" || true

# 自動手順からの撮影の合図を待って撮る。FINISHED / ERROR か、時間切れ（15 分）で終わる
LAST=""
END=$((SECONDS + 900))
STATUS=1
START=$SECONDS
while [ $SECONDS -lt $END ]; do
  # 4 分たっても最初の合図が来なければ、自動手順が動いていないので待たずに終わる
  if [ -z "$LAST" ] && [ $((SECONDS - START)) -gt 240 ]; then echo "== 最初の合図が来ません"; break; fi
  REQ=$(cat "$DOCS/shot-request.txt" 2>/dev/null || true)
  if [ -n "$REQ" ] && [ "$REQ" != "$LAST" ]; then
    LAST=$REQ
    if [ "$REQ" = "FINISHED" ]; then STATUS=0; echo "== 撮り終わりました"; break; fi
    if [ "$REQ" = "ERROR" ]; then echo "== 自動手順が途中で止まりました"; break; fi
    xcrun simctl io "$UDID" screenshot --type=png "$OUT/${LABEL}_${REQ}.png"
    printf '%s' "$REQ" > "$DOCS/shot-done.txt"
  fi
  sleep 0.3
done
[ $SECONDS -ge $END ] && echo "== 時間切れ（合図が来ませんでした）"

xcrun simctl io "$UDID" screenshot --type=png "$OUT/_last.png" || true
cp "$DOCS/shot-log.txt" "$OUT/shot-log.txt" 2>/dev/null || true
echo "== 撮った画像"
ls -la "$OUT"
for f in "$OUT"/${LABEL}_*.png; do [ -f "$f" ] && sips -g pixelWidth -g pixelHeight "$f" | tail -2 | tr '\n' ' ' && echo " $f"; done
# 次の機種を続けて撮るときのために、このシミュレータは止めておく
xcrun simctl shutdown "$UDID" 2>/dev/null || true
exit $STATUS
