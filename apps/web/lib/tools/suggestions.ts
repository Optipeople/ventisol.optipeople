// The questions offered in an empty chat: the six from the deck. The first
// asks about a real order in progress (example-order.ts), since the deck's
// example number does not exist here; with none in progress it is left out.

const OTHER_SUGGESTIONS = [
  "Hvor venter ordrerne mest i denne uge?",
  "Holder kalkulen pr. elementtype?",
  "Passer næste uges batches ind?",
  "Hvor mange skal stå ved montagen?",
  "Hvad skal ledelsen vide i dag?",
];

export function suggestions(orderNo: number | null): string[] {
  return [
    ...(orderNo == null ? [] : [`Hvor er ordrenummer ${orderNo}, og hvornår er den klar til afsendelse?`]),
    ...OTHER_SUGGESTIONS,
  ];
}
