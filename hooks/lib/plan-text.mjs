// Plan summaries and risks are free text that often already end with a period.
export const trimPeriod = (text) => String(text ?? '').replace(/[.\s]+$/, '');
