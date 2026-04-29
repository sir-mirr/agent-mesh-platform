export const MAX_DISCORD_TEXT_LENGTH = 2000;

export function chunkDiscordText(
  text: string,
  limit: number,
  mode: "length" | "newline",
): string[] {
  if (text.length === 0) return [];
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = limit;
    if (mode === "newline") {
      const paragraph = rest.lastIndexOf("\n\n", limit);
      const line = rest.lastIndexOf("\n", limit);
      const space = rest.lastIndexOf(" ", limit);
      cut =
        paragraph > limit / 2
          ? paragraph
          : line > limit / 2
            ? line
            : space > 0
              ? space
              : limit;
    }
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, "");
  }
  if (rest) chunks.push(rest);
  return chunks;
}
