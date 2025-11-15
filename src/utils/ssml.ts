const BASIC_ENTITIES: Record<string, string> = {
  "&nbsp;": " ",
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
};

export function ssmlToPlainText(ssml: string): string {
  if (!ssml) {
    return "";
  }

  const withoutComments = ssml.replace(/<!--[\s\S]*?-->/g, " ");
  const withoutTags = withoutComments.replace(/<[^>]+>/g, " ");
  const decoded = decodeBasicEntities(withoutTags);
  return decoded.replace(/\s+/g, " ").trim();
}

function decodeBasicEntities(input: string): string {
  let output = input;
  for (const [entity, replacement] of Object.entries(BASIC_ENTITIES)) {
    output = output.replace(new RegExp(entity, "gi"), replacement);
  }
  return output;
}
