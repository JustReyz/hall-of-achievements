export interface ValidatedAchievementInput {
  title: string;
  completionDate: string;
  notes: string;
  tags: string[];
}

export class ValidationError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(code: string, message: string, statusCode: number = 400) {
    super(message);
    this.name = 'ValidationError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

export function validateTitle(title: unknown): string {
  if (typeof title !== 'string') {
    throw new ValidationError('INVALID_TITLE', 'Title must be a string.');
  }

  const trimmed = title.trim();
  if (trimmed.length < 1) {
    throw new ValidationError('INVALID_TITLE', 'Title cannot be empty.');
  }

  if (trimmed.length > 120) {
    throw new ValidationError('TITLE_TOO_LONG', 'Title cannot exceed 120 characters.');
  }

  return trimmed;
}

export function validateCalendarDate(dateStr: unknown): string {
  if (typeof dateStr !== 'string') {
    throw new ValidationError('INVALID_COMPLETION_DATE', 'Completion date must be a string in YYYY-MM-DD format.');
  }

  const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
  if (!dateRegex.test(dateStr)) {
    throw new ValidationError('INVALID_COMPLETION_DATE', 'Completion date must follow YYYY-MM-DD format.');
  }

  const parts = dateStr.split('-').map((v) => parseInt(v, 10));
  const year = parts[0];
  const month = parts[1];
  const day = parts[2];

  if (year === undefined || month === undefined || day === undefined) {
    throw new ValidationError('INVALID_COMPLETION_DATE', 'Completion date must follow YYYY-MM-DD format.');
  }

  const parsedDate = new Date(Date.UTC(year, month - 1, day));

  if (
    parsedDate.getUTCFullYear() !== year ||
    parsedDate.getUTCMonth() !== month - 1 ||
    parsedDate.getUTCDate() !== day
  ) {
    throw new ValidationError('INVALID_COMPLETION_DATE', 'Completion date is not a valid calendar date.');
  }

  return dateStr;
}

export function validateCompletionDate(dateStr: unknown, timezone?: string): string {
  const validatedDate = validateCalendarDate(dateStr);

  // Check that completion date is not in the future relative to user's timezone
  let todayInTz: string;
  let resolvedTimezone = timezone || 'UTC';
  try {
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: resolvedTimezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    todayInTz = formatter.format(new Date());
  } catch {
    // Fallback to UTC if timezone is invalid
    resolvedTimezone = 'UTC';
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'UTC',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    todayInTz = formatter.format(new Date());
  }

  if (validatedDate > todayInTz) {
    throw new ValidationError(
      'INVALID_COMPLETION_DATE',
      `Completion date cannot be in the future (today is ${todayInTz} in timezone ${resolvedTimezone}).`
    );
  }

  return validatedDate;
}

export function validateDateRange(
  from: string | null | undefined,
  to: string | null | undefined
): { from: string; to: string } {
  const start = from?.trim() ?? '';
  const end = to?.trim() ?? '';
  if (start) validateCalendarDate(start);
  if (end) validateCalendarDate(end);
  if (start && end && start > end) {
    throw new ValidationError('INVALID_DATE_RANGE', 'Completed from must not be after Completed through.');
  }
  return { from: start, to: end };
}

export function validateNotes(notes: unknown): string {
  if (notes === undefined || notes === null) {
    return '';
  }

  if (typeof notes !== 'string') {
    throw new ValidationError('INVALID_NOTES', 'Notes must be a string.');
  }

  if (notes.length > 2000) {
    throw new ValidationError('NOTES_TOO_LONG', 'Notes cannot exceed 2000 characters.');
  }

  return notes;
}

function normalizeTagValue(tag: string): string {
  const normalized = tag.trim().toLowerCase();
  if (normalized.length > 24) {
    throw new ValidationError('INVALID_TAGS', `Tag "${normalized}" exceeds the maximum length of 24 characters.`);
  }
  return normalized;
}

export function validateTagFilter(tag: unknown): string {
  if (tag === undefined || tag === null) {
    return '';
  }

  if (typeof tag !== 'string') {
    throw new ValidationError('INVALID_TAGS', 'Tag filter must be a string.');
  }

  return normalizeTagValue(tag);
}

export function validateTags(tags: unknown): string[] {
  if (tags === undefined || tags === null) {
    return [];
  }

  if (!Array.isArray(tags)) {
    throw new ValidationError('INVALID_TAGS', 'Tags must be an array of strings.');
  }

  if (tags.length > 10) {
    throw new ValidationError('INVALID_TAGS', 'A maximum of 10 tags is allowed.');
  }

  const normalizedSet = new Set<string>();

  for (const tag of tags) {
    if (typeof tag !== 'string') {
      throw new ValidationError('INVALID_TAGS', 'Each tag must be a string.');
    }

    const normalized = normalizeTagValue(tag);
    if (normalized.length === 0) continue;

    normalizedSet.add(normalized);
  }

  return Array.from(normalizedSet);
}
