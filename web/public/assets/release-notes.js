/** Plain-text blocks or Markdown sections, each rendered as one release-note card. */
export function noteSections(text) {
  const sections = [];
  let section = null;
  let hasHeading = false;
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const line = raw.trim();
    const heading = line.match(/^#{1,6}\s+(.+?)(?:\s+#+)?$/);
    if (heading) {
      section = [heading[1]];
      sections.push(section);
      hasHeading = true;
    } else if (!line) {
      // Markdown leaves a blank line between a heading and its list. Plain notes use
      // blank lines to separate cards, so retain that format until a heading appears.
      if (!hasHeading) section = null;
    } else {
      if (!section) sections.push((section = []));
      section.push(line);
    }
  }
  return sections;
}
