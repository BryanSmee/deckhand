# Passes `agy --output-format stream-json` through as it comes, but for an answer's text
# deltas, which it joins into one line of Deckhand's per answer: {event: "deckhand.text",
# step_index, text}, once that answer's step moves on. The listener reads that line as the
# message (../../listener/agents/antigravity.mjs), not its pieces. Run with -nRr: each line is
# an input.
def flushed:
  if .text == "" then [] else [{event: "deckhand.text", step_index: .step, text: .text} | tojson] end;
foreach ((inputs | {line: ., e: (fromjson? // null)}), {end: true}) as $in (
  {step: null, text: "", out: []};
  ($in.e | if type == "object" and .event == "step_update" then .step_update else null end) as $s
  | if ($s | type) == "object" and $s.step_type == "agent_response"
      and ($s.text_delta | type) == "string" then
      (if .step != $s.step_index then .out = flushed | .text = "" else .out = [] end)
      | .step = $s.step_index
      | .text += $s.text_delta
    else
      .out = flushed + (if $in.end then [] else [$in.line] end)
      | .text = ""
      | .step = null
    end;
  .out[]
)
