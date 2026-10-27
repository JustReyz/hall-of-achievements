'use client';

interface TagBrowserProps {
  tags: string[];
  selectedTag: string;
  loading: boolean;
  error: string | null;
  onSelect: (tag: string) => void;
  onRetry: () => void;
}

function tagButtonStyle(active: boolean) {
  return {
    minHeight: 44,
    padding: '8px 12px',
    borderRadius: 999,
    border: active ? '1px solid #1d4ed8' : '1px solid #cbd5e1',
    backgroundColor: active ? '#2563eb' : '#fff',
    color: active ? '#fff' : '#334155',
    fontSize: 13,
    fontWeight: 600,
    cursor: 'pointer',
  } as const;
}

export function TagBrowser({
  tags,
  selectedTag,
  loading,
  error,
  onSelect,
  onRetry,
}: TagBrowserProps) {
  const visibleTags =
    selectedTag && !tags.includes(selectedTag) ? [selectedTag, ...tags] : tags;

  return (
    <section
      aria-labelledby="tag-browser-heading"
      style={{
        margin: '0 0 20px 0',
        padding: '14px 16px',
        borderRadius: 10,
        border: '1px solid #e2e8f0',
        backgroundColor: '#f8fafc',
      }}
    >
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
          marginBottom: 10,
        }}
      >
        <h2
          id="tag-browser-heading"
          style={{
            margin: 0,
            fontSize: 13,
            fontWeight: 700,
            letterSpacing: '0.05em',
            textTransform: 'uppercase',
            color: '#475569',
          }}
        >
          Browse by tag
        </h2>
        {loading && (
          <span role="status" style={{ fontSize: 13, color: '#64748b' }}>
            Loading tags…
          </span>
        )}
      </div>

      <div
        role="group"
        aria-label="Filter by tag"
        style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}
      >
        <button
          type="button"
          onClick={() => onSelect('')}
          aria-pressed={selectedTag === ''}
          style={tagButtonStyle(selectedTag === '')}
        >
          All tags
        </button>
        {visibleTags.map((tag) => (
          <button
            key={tag}
            type="button"
            onClick={() => onSelect(tag)}
            aria-pressed={selectedTag === tag}
            aria-label={`Filter by tag ${tag}`}
            style={tagButtonStyle(selectedTag === tag)}
          >
            #{tag}
          </button>
        ))}
      </div>

      {!loading && !error && visibleTags.length === 0 && (
        <p style={{ margin: '10px 0 0 0', fontSize: 13, color: '#64748b' }}>
          No tags recorded yet.
        </p>
      )}

      {error && (
        <div
          role="alert"
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            gap: 10,
            marginTop: 10,
            color: '#991b1b',
            fontSize: 13,
          }}
        >
          <span>{error}</span>
          <button
            type="button"
            onClick={onRetry}
            style={{
              minHeight: 44,
              padding: '8px 12px',
              borderRadius: 6,
              border: '1px solid #fca5a5',
              backgroundColor: '#fff',
              color: '#991b1b',
              fontSize: 13,
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            Retry tags
          </button>
        </div>
      )}
    </section>
  );
}
