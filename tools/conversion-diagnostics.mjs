// Explicit warning lines remain visible without counting as conversion defects.
// Unclassified stderr stays an error so existing loud fallbacks keep their meaning.
export const WARNING_PREFIX = 'MWGP warning: ';

export function summarizeDiagnostics(log) {
  const lines = log.split(/\r?\n/).filter(Boolean);
  const warnings = lines.filter(line => line.startsWith(WARNING_PREFIX)).length;
  const errors = lines.length - warnings;
  let status = 'converted';
  if (errors) status = 'converted with errors';
  else if (warnings) status = 'converted with warnings';
  return {
    status,
    warnings,
    errors,
    ...(lines.length ? { reason: `${errors} error(s), ${warnings} warning(s)` } : {})
  };
}
