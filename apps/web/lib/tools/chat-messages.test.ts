// The mapping from AI SDK messages to the shared chat views
// (components/chat/messages.ts). It lives here because vitest collects
// lib/**/*.test.ts only.

import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";
import { growthKey, toChatRow } from "@/components/chat/messages";

const options = {
  toolLabel: (name: string) => `Henter ${name}`,
  startedAt: { "call-2": 5000 },
  fallbackStart: 1000,
};

const result = { data: { n: 1 }, views: [{ kind: "note" as const, text: "En note" }], href: "/ordrer" };

describe("toChatRow", () => {
  it("keeps the user's text as written", () => {
    const message: UIMessage = { id: "u1", role: "user", parts: [{ type: "text", text: "Hvor er ordre 1042?" }] };
    const row = toChatRow(message, options);
    expect(row.message).toMatchObject({ id: "u1", role: "user", content: "Hvor er ordre 1042?" });
    expect(row.outcomes).toEqual([]);
  });

  it("joins the answer's text parts as paragraphs and keeps finished tools apart", () => {
    const message = {
      id: "a1",
      role: "assistant",
      parts: [
        { type: "step-start" },
        { type: "text", text: "Jeg slår det op." },
        { type: "tool-find_order", toolCallId: "call-1", state: "output-available", input: {}, output: result },
        { type: "text", text: "  " },
        { type: "text", text: "Ordren er på station 30." },
      ],
    } as UIMessage;
    const row = toChatRow(message, options);
    expect(row.message.content).toBe("Jeg slår det op.\n\nOrdren er på station 30.");
    expect(row.message.toolSteps).toEqual([]);
    expect(row.outcomes).toEqual([{ id: "call-1", name: "find_order", state: "done", result }]);
  });

  it("shows a running tool as a step with its label and start time", () => {
    const message = {
      id: "a2",
      role: "assistant",
      parts: [
        { type: "tool-today", toolCallId: "call-2", state: "input-available", input: {} },
        { type: "tool-stations", toolCallId: "call-3", state: "input-streaming", input: undefined },
      ],
    } as UIMessage;
    const row = toChatRow(message, options);
    expect(row.message.content).toBe("");
    expect(row.message.toolSteps).toEqual([
      { id: "call-2", name: "today", label: "Henter today…", startedAt: 5000 },
      { id: "call-3", name: "stations", label: "Henter stations…", startedAt: 1000 },
    ]);
    expect(row.outcomes).toEqual([]);
  });

  it("keeps a failed tool as an outcome, not as a running step", () => {
    const message = {
      id: "a3",
      role: "assistant",
      parts: [{ type: "tool-today", toolCallId: "call-4", state: "output-error", input: {}, errorText: "boom" }],
    } as UIMessage;
    const row = toChatRow(message, options);
    expect(row.message.toolSteps).toEqual([]);
    expect(row.outcomes).toEqual([{ id: "call-4", name: "today", state: "failed" }]);
  });
});

describe("growthKey", () => {
  it("changes when the last answer grows", () => {
    const at = (text: string) =>
      growthKey([toChatRow({ id: "a", role: "assistant", parts: [{ type: "text", text }] }, options)]);
    expect(at("Hej")).not.toBe(at("Hej med dig"));
    expect(growthKey([])).toBe("0");
  });
});
