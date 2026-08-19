const controlCharacters = /[\u0000-\u001f\u007f-\u009f]/gu;

export function buildRedmineSubject(input: {
  comment: string;
  perspectiveCode: string;
  threadId: string;
}): string {
  const line = input.comment
    .split(/\r?\n/u)
    .map((value) => value.replace(controlCharacters, "").replace(/\s+/gu, " ").trim())
    .find(Boolean);
  const value = `[${input.perspectiveCode}] ${line || `Feedback ${input.threadId}`}`;
  const scalars = Array.from(value);
  return scalars.length <= 255 ? value : `${scalars.slice(0, 254).join("")}…`;
}
