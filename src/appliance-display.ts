export default function formatApplianceDisplayText(
  value: string | null | undefined,
): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;

  const normalized = trimmed.replace(/_+/g, ' ').replace(/\s+/g, ' ').trim();
  const firstLetter = normalized.match(/[A-Za-z]/)?.[0];
  if (!trimmed.includes('_') && firstLetter && firstLetter === firstLetter.toUpperCase()) {
    return normalized;
  }
  return normalized.replace(
    /[A-Za-z]+/g,
    (word) => `${word.charAt(0).toUpperCase()}${word.slice(1).toLowerCase()}`,
  );
}
