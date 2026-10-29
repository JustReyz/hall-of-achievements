'use client';

import { useState, useEffect, useRef } from 'react';

interface SearchBarProps {
  onSearch: (query: string) => void;
  disabled?: boolean;
}

export function SearchBar({ onSearch, disabled }: SearchBarProps) {
  const [value, setValue] = useState('');
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);
  const isFirstRender = useRef(true);
  const onSearchRef = useRef(onSearch);

  useEffect(() => {
    onSearchRef.current = onSearch;
  }, [onSearch]);

  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }

    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
    }

    timeoutRef.current = setTimeout(() => {
      onSearchRef.current(value.trim());
    }, 300);

    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, [value]);

  const handleClear = () => {
    setValue('');
    onSearch('');
  };

  return (
    <div className="gallery-search-field">
      <label htmlFor="gallery-search-input" className="sr-only">
        Search artwork by title or tag
      </label>
      <input
        id="gallery-search-input"
        className="gallery-search-input"
        type="search"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        disabled={disabled}
        placeholder="Search artwork or #tags..."
      />
      {value && (
        <button
          type="button"
          className="gallery-search-clear"
          onClick={handleClear}
          aria-label="Clear search"
        >
          <span aria-hidden="true">×</span>
        </button>
      )}
    </div>
  );
}
