'use client';

interface TagBrowserProps {
  tags: string[];
  selectedTag: string;
  loading: boolean;
  error: string | null;
  onSelect: (tag: string) => void;
  onRetry: () => void;
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
    <section className="gallery-tag-browser" aria-labelledby="tag-browser-heading">
      <div className="gallery-tag-browser-header">
        <h2 id="tag-browser-heading">Browse by tag</h2>
        {loading && (
          <span role="status" className="gallery-tag-note">
            Loading tags...
          </span>
        )}
      </div>

      <div role="group" aria-label="Filter by tag" className="gallery-tag-list">
        <button
          type="button"
          className="gallery-tag"
          onClick={() => onSelect('')}
          aria-pressed={selectedTag === ''}
        >
          All tags
        </button>
        {visibleTags.map((tag) => (
          <button
            key={tag}
            type="button"
            className="gallery-tag"
            onClick={() => onSelect(tag)}
            aria-pressed={selectedTag === tag}
            aria-label={`Filter by tag ${tag}`}
          >
            #{tag}
          </button>
        ))}
      </div>

      {!loading && !error && visibleTags.length === 0 && (
        <p className="gallery-tag-note">No tags recorded yet.</p>
      )}

      {error && (
        <div role="alert" className="gallery-tag-error">
          <span>{error}</span>
          <button type="button" className="gallery-button" onClick={onRetry}>
            Retry tags
          </button>
        </div>
      )}
    </section>
  );
}
