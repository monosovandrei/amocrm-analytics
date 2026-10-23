import { useState, useRef, useId, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import { ArrowDown } from 'lucide-react';
import type { FieldOption } from './report-types';

export default function FieldCombobox({
  emptyText = 'Поля появятся после синхронизации amoCRM',
  label,
  onChange,
  options,
  placeholder,
  value,
}: {
  emptyText?: string;
  label: string;
  onChange: (value: string) => void;
  options: FieldOption[];
  placeholder: string;
  value: string;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState('');
  const triggerRef=useRef<HTMLButtonElement>(null),panelRef=useRef<HTMLDivElement>(null);
  const listId=useId();
  const [position,setPosition]=useState({top:0,left:0,width:280});
  useLayoutEffect(()=>{
    if(!isOpen)return;
    const update=()=>{const rect=triggerRef.current?.getBoundingClientRect();if(!rect)return;
      const width=Math.min(Math.max(rect.width,280),window.innerWidth-24);
      const maxHeight=Math.min(320,window.innerHeight-24);
      const top=rect.bottom+maxHeight>window.innerHeight?Math.max(12,rect.top-maxHeight-6):rect.bottom+6;
      setPosition({top,left:Math.max(12,Math.min(rect.left,window.innerWidth-width-12)),width});};
    update();window.addEventListener('resize',update);window.addEventListener('scroll',update,true);
    return()=>{window.removeEventListener('resize',update);window.removeEventListener('scroll',update,true);};
  },[isOpen]);
  const selected = options.find((option) => option.value === value);
  const normalizedQuery = query.trim().toLowerCase();
  const filteredOptions = normalizedQuery
    ? options.filter((option) =>
        `${option.label} ${option.description ?? ''} ${option.value}`.toLowerCase().includes(normalizedQuery),
      )
    : options;

  return (
    <div
      className="field-combobox"
      onBlur={(event) => {
        const nextTarget = event.relatedTarget;
        // Portal input autofocus runs before the parent's ref callback during commit.
        const panel=panelRef.current||document.getElementById(listId);
        if (!(nextTarget instanceof Node) || (!event.currentTarget.contains(nextTarget)&&!panel?.contains(nextTarget))) setIsOpen(false);
      }}
    >
      <span className="label">{label}</span>
      <button
        ref={triggerRef}
        className="field-combobox-trigger"
        type="button"
        onClick={() => setIsOpen((current) => !current)}
        aria-expanded={isOpen}
        aria-controls={listId}
        aria-label={label}
        onKeyDown={event=>{if(event.key==='Escape')setIsOpen(false);}}
      >
        <span className={selected ? 'truncate' : 'truncate text-[var(--pb-text-muted)]'}>
          {selected?.label ?? placeholder}
        </span>
        <ArrowDown size={14} className="shrink-0 text-[var(--pb-text-secondary)]" />
      </button>

      {isOpen && createPortal(
        <div ref={panelRef} id={listId} className="field-combobox-panel" style={{position:'fixed',...position,zIndex:80,maxHeight:320}}
          onKeyDown={event=>{if(event.key==='Escape'){setIsOpen(false);triggerRef.current?.focus();}}}
          onBlur={event=>{const target=event.relatedTarget;if(!(target instanceof Node)||(!panelRef.current?.contains(target)&&target!==triggerRef.current))setIsOpen(false);}}>
          <input
            className="field-combobox-search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Поиск"
            aria-label={`Поиск: ${label}`}
            autoFocus
          />
          <div className="field-combobox-list">
            {filteredOptions.length === 0 && (
              <div className="px-2 py-2 text-xs text-[var(--pb-text-secondary)]">{emptyText}</div>
            )}
            {filteredOptions.map((option) => (
              <button
                key={`${option.value}:${option.label}`}
                className={`field-combobox-option ${option.value === value ? 'active' : ''}`}
                type="button"
                onClick={() => {
                  onChange(option.value);
                  setQuery('');
                  setIsOpen(false);
                  triggerRef.current?.focus();
                }}
              >
                <span className="truncate font-semibold">{option.label}</span>
                {option.description && <span className="truncate text-xs text-[var(--pb-text-secondary)]">{option.description}</span>}
              </button>
            ))}
          </div>
        </div>,document.body
      )}
    </div>
  );
}
