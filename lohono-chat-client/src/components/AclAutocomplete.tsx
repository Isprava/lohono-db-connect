import { useState, useRef, useEffect } from "react";

interface AclAutocompleteProps {
  availableAcls: string[];
  selectedAcls: string[];
  onChange: (acls: string[]) => void;
}

const MAX_VISIBLE = 50;

export default function AclAutocomplete({
  availableAcls,
  selectedAcls,
  onChange,
}: AclAutocompleteProps) {
  const [query, setQuery] = useState("");
  const [isOpen, setIsOpen] = useState(false);
  const [visibleCount, setVisibleCount] = useState(MAX_VISIBLE);
  const containerRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const filtered = availableAcls.filter(
    (acl) =>
      !selectedAcls.includes(acl) &&
      acl.toLowerCase().includes(query.toLowerCase())
  );

  const visibleItems = filtered.slice(0, visibleCount);
  const hasMore = filtered.length > visibleCount;

  // Reset visible count when query changes
  useEffect(() => {
    setVisibleCount(MAX_VISIBLE);
  }, [query]);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  // Load more on scroll to bottom
  const handleScroll = () => {
    const el = listRef.current;
    if (!el || !hasMore) return;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 20) {
      setVisibleCount((prev) => prev + MAX_VISIBLE);
    }
  };

  const addAcl = (acl: string) => {
    onChange([...selectedAcls, acl]);
    setQuery("");
  };

  const removeAcl = (acl: string) => {
    onChange(selectedAcls.filter((a) => a !== acl));
  };

  return (
    <div ref={containerRef} className="relative">
      {/* Selected chips */}
      <div className="flex flex-wrap gap-1.5 mb-2">
        {selectedAcls.map((acl) => (
          <span
            key={acl}
            className="inline-flex items-center gap-1 px-2.5 py-1 bg-gray-200 text-gray-700 text-xs font-medium rounded-full border border-gray-300"
          >
            {acl}
            <button
              onClick={() => removeAcl(acl)}
              className="hover:text-red-400 transition-colors ml-0.5"
              aria-label={`Remove ${acl}`}
            >
              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </span>
        ))}
      </div>

      {/* Search input */}
      <input
        type="text"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setIsOpen(true);
        }}
        onFocus={() => setIsOpen(true)}
        placeholder="Search and add ACLs..."
        className="w-full px-3 py-2 text-sm border border-secondary/20 rounded-lg bg-white focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent/30 transition-colors"
      />

      {/* Dropdown */}
      {isOpen && filtered.length > 0 && (
        <div
          ref={listRef}
          onScroll={handleScroll}
          className="absolute z-10 mt-1 w-full max-h-64 overflow-y-auto bg-white border border-secondary/20 rounded-lg shadow-lg"
        >
          {/* Result count hint */}
          <div className="sticky top-0 bg-white/95 backdrop-blur-sm px-3 py-1.5 text-xs text-text/40 border-b border-secondary/10">
            {filtered.length} result{filtered.length !== 1 ? "s" : ""}
            {query && ` matching "${query}"`}
          </div>
          {visibleItems.map((acl) => (
            <button
              key={acl}
              onClick={() => addAcl(acl)}
              className="w-full text-left px-3 py-2 text-sm hover:bg-accent/10 transition-colors"
            >
              {acl}
            </button>
          ))}
          {hasMore && (
            <div className="px-3 py-2 text-xs text-text/40 text-center">
              Scroll for more...
            </div>
          )}
        </div>
      )}

      {isOpen && query && filtered.length === 0 && (
        <div className="absolute z-10 mt-1 w-full bg-white border border-secondary/20 rounded-lg shadow-lg">
          <p className="px-3 py-2 text-sm text-text/40">No matching ACLs</p>
        </div>
      )}
    </div>
  );
}
