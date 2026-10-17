# Turns `agy`'s stream-json (with text.jq's lines) into readable progress: its answers, one
# line per tool call, and a closing summary. Lines that are not JSON pass through.
(fromjson? // { event: "raw", text: . }) as $m
| if $m.event == "deckhand.text" then
    "\n" + $m.text + "\n"
  elif $m.event == "step_update" and $m.step_update.step_type == "tool"
    and $m.step_update.state == "ACTIVE" then
    "  → " + ($m.step_update.tool_name // "tool") + " "
    + ($m.step_update.tool_info.parameters // {} | [.[] | strings][0] // "" | split("\n")[0] | .[0:100])
    + "\n"
  elif $m.event == "result" then
    "\n" + (if $m.result.status == "SUCCESS" then "Done" else "Failed: " + ($m.result.error // "") end)
    + " in \(($m.result.duration_seconds // 0) / 6 | floor / 10) min\n"
  elif $m.event == "raw" then $m.text + "\n"
  else empty end
