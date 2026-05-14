import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { Project } from '@mindwtr/core';
import { ChevronDown, Plus } from 'lucide-react';
import { cn } from '../../lib/utils';
import { useDropdownPosition } from './use-dropdown-position';

interface ProjectSelectorProps {
    projects: Project[];
    allProjects?: Project[];
    value: string;
    onChange: (projectId: string) => void;
    onCreateProject?: (title: string) => Promise<string | null>;
    placeholder?: string;
    noProjectLabel?: string;
    searchPlaceholder?: string;
    noMatchesLabel?: string;
    emptyLabel?: string;
    createProjectLabel?: string;
    className?: string;
}

const isSelectableProject = (project: Project): boolean => {
    const status = String(project.status);
    return !project.deletedAt && status !== 'archived' && status !== 'completed';
};

export function ProjectSelector({
    projects,
    allProjects,
    value,
    onChange,
    onCreateProject,
    placeholder = 'Select project',
    noProjectLabel = 'No project',
    searchPlaceholder = 'Search projects',
    noMatchesLabel = 'No matches',
    emptyLabel,
    createProjectLabel = 'Create project',
    className,
}: ProjectSelectorProps) {
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState('');
    const containerRef = useRef<HTMLDivElement>(null);
    const dropdownRef = useRef<HTMLDivElement>(null);
    const projectPool = allProjects ?? projects;
    const selected = projectPool.find((p) => p.id === value);
    const { dropdownClassName, listMaxHeight } = useDropdownPosition({
        open,
        containerRef,
        dropdownRef,
    });

    const normalizedQuery = query.trim().toLowerCase();
    const selectableProjects = useMemo(
        () => projects.filter(isSelectableProject),
        [projects]
    );
    const filtered = useMemo(() => {
        if (!normalizedQuery) return selectableProjects;
        return selectableProjects.filter((project) => project.title.toLowerCase().includes(normalizedQuery));
    }, [selectableProjects, normalizedQuery]);

    const hasExactMatch = useMemo(() => {
        if (!normalizedQuery) return false;
        return projectPool.some((project) => project.title.toLowerCase() === normalizedQuery);
    }, [normalizedQuery, projectPool]);

    useEffect(() => {
        if (!open) return;
        const handleClick = (event: MouseEvent) => {
            if (!containerRef.current?.contains(event.target as Node)) {
                setOpen(false);
            }
        };
        document.addEventListener('mousedown', handleClick);
        return () => document.removeEventListener('mousedown', handleClick);
    }, [open]);

    const closeDropdown = () => {
        setOpen(false);
        setQuery('');
    };

    const focusSelectableOption = (direction: 1 | -1) => {
        const options = dropdownRef.current?.querySelectorAll<HTMLButtonElement>('[data-selector-option="true"]');
        if (!options || options.length === 0) return;
        const list = Array.from(options);
        const active = document.activeElement as HTMLElement | null;
        let index = list.findIndex((option) => option === active);
        if (index < 0) {
            index = direction > 0 ? -1 : 0;
        }
        const nextIndex = (index + direction + list.length) % list.length;
        list[nextIndex].focus();
    };

    const handleDropdownKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
        if (event.key === 'Escape') {
            event.preventDefault();
            closeDropdown();
            return;
        }
        if (event.key === 'ArrowDown') {
            event.preventDefault();
            focusSelectableOption(1);
            return;
        }
        if (event.key === 'ArrowUp') {
            event.preventDefault();
            focusSelectableOption(-1);
        }
    };

    const handleCreate = async () => {
        if (!onCreateProject) return;
        const title = query.trim();
        if (!title) return;
        const id = await onCreateProject(title);
        if (id) {
            onChange(id);
        }
        closeDropdown();
    };

    const emptyStateLabel = normalizedQuery ? noMatchesLabel : (emptyLabel ?? noMatchesLabel);

    return (
        <div ref={containerRef} className={cn('relative', className)}>
            <button
                type="button"
                onClick={() => setOpen((prev) => !prev)}
                onKeyDown={(event) => {
                    if (event.key === 'Escape' && open) {
                        event.preventDefault();
                        closeDropdown();
                    }
                }}
                className="w-full flex items-center justify-between text-xs bg-muted/50 border border-border rounded px-2 py-1 text-foreground"
                aria-haspopup="listbox"
                aria-expanded={open}
            >
                <span className="truncate">{selected?.title ?? placeholder}</span>
                <ChevronDown className="h-3.5 w-3.5 opacity-70" />
            </button>
            {open && (
                <div
                    ref={dropdownRef}
                    className={cn('absolute z-20 w-full rounded-md border border-border bg-popover shadow-lg p-1 text-xs', dropdownClassName)}
                    onKeyDown={handleDropdownKeyDown}
                >
                    <input
                        autoFocus
                        value={query}
                        onChange={(event) => setQuery(event.target.value)}
                        placeholder={searchPlaceholder}
                        aria-label={searchPlaceholder}
                        className="w-full mb-1 rounded border border-border bg-muted/40 px-2 py-1 text-xs"
                    />
                    <div role="listbox" aria-label={placeholder}>
                        <button
                            type="button"
                            data-selector-option="true"
                            role="option"
                            aria-selected={value === ''}
                            onClick={() => {
                                onChange('');
                                closeDropdown();
                            }}
                            className={cn(
                                'w-full text-left px-2 py-1 rounded hover:bg-muted/50',
                                value === '' && 'bg-muted/70'
                            )}
                        >
                            {noProjectLabel}
                        </button>
                        {!hasExactMatch && query.trim() && onCreateProject && (
                            <button
                                type="button"
                                data-selector-option="true"
                                role="option"
                                aria-selected={false}
                                onClick={handleCreate}
                                className="w-full text-left px-2 py-1 rounded hover:bg-muted/50 text-primary flex items-center gap-2"
                            >
                                <Plus className="h-3.5 w-3.5" />
                                {createProjectLabel} &quot;{query.trim()}&quot;
                            </button>
                        )}
                        <div className="overflow-y-auto" style={{ maxHeight: listMaxHeight }}>
                            {filtered.map((project) => (
                                <button
                                    key={project.id}
                                    type="button"
                                    data-selector-option="true"
                                    role="option"
                                    aria-selected={project.id === value}
                                    onClick={() => {
                                        onChange(project.id);
                                        closeDropdown();
                                    }}
                                    className={cn(
                                        'w-full text-left px-2 py-1 rounded hover:bg-muted/50',
                                        project.id === value && 'bg-muted/70'
                                    )}
                                >
                                    {project.title}
                                </button>
                            ))}
                            {filtered.length === 0 && (
                                <div className="px-2 py-1 text-muted-foreground">{emptyStateLabel}</div>
                            )}
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
