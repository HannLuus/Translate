import { useState } from 'react';
import type { ScenarioProfile, GlossaryEntry } from '../types';

interface Props {
  profiles: ScenarioProfile[];
  activeProfileId: string;
  disabled: boolean;
  useGlossaryAndBriefing: boolean;
  onUseGlossaryAndBriefingChange: (value: boolean) => void;
  onProfilesChange: (profiles: ScenarioProfile[]) => void;
  onActiveProfileIdChange: (id: string) => void;
}

export function ScenarioProfilePanel({
  profiles,
  activeProfileId,
  disabled,
  useGlossaryAndBriefing,
  onUseGlossaryAndBriefingChange,
  onProfilesChange,
  onActiveProfileIdChange,
}: Props) {
  const [editingGlossaryId, setEditingGlossaryId] = useState<number | null>(null);
  const [glossaryExpanded, setGlossaryExpanded] = useState(false);

  const activeProfile = profiles.find((p) => p.id === activeProfileId) ?? profiles[0];

  function updateActiveProfile(patch: Partial<ScenarioProfile>) {
    onProfilesChange(profiles.map((p) => (p.id === activeProfile.id ? { ...p, ...patch } : p)));
  }

  function addProfile() {
    const id = `profile-${Date.now()}`;
    const newProfile: ScenarioProfile = {
      id,
      name: 'New profile',
      briefing: '',
      glossary: [],
      createdAt: Date.now(),
    };
    onProfilesChange([...profiles, newProfile]);
    onActiveProfileIdChange(id);
    setGlossaryExpanded(false);
    setEditingGlossaryId(null);
  }

  function duplicateProfile() {
    const id = `profile-${Date.now()}`;
    const dup: ScenarioProfile = {
      ...activeProfile,
      id,
      name: `Copy of ${activeProfile.name}`,
      createdAt: Date.now(),
    };
    onProfilesChange([...profiles, dup]);
    onActiveProfileIdChange(id);
  }

  function deleteProfile() {
    if (profiles.length <= 1) return;
    if (!window.confirm(`Delete profile "${activeProfile.name}"? This cannot be undone.`)) return;
    const remaining = profiles.filter((p) => p.id !== activeProfile.id);
    onProfilesChange(remaining);
    onActiveProfileIdChange(remaining[0].id);
    setGlossaryExpanded(false);
    setEditingGlossaryId(null);
  }

  function updateGlossaryEntry(id: number, patch: Partial<GlossaryEntry>) {
    updateActiveProfile({
      glossary: activeProfile.glossary.map((e) => (e.id === id ? { ...e, ...patch } : e)),
    });
  }

  function addGlossaryEntry() {
    const id = Date.now();
    updateActiveProfile({ glossary: [...activeProfile.glossary, { id, term: '', meaning: '' }] });
    setEditingGlossaryId(id);
    setGlossaryExpanded(true);
  }

  function deleteGlossaryEntry(id: number) {
    updateActiveProfile({ glossary: activeProfile.glossary.filter((e) => e.id !== id) });
    if (editingGlossaryId === id) setEditingGlossaryId(null);
  }

  return (
    <details className="app__context-panel">
      <summary>Scenario Profile &amp; Glossary</summary>

      <label
        className="app__glossary-use-toggle"
        title="Turn off for casual conversations so the interpreter does not use profile context."
      >
        <input
          type="checkbox"
          checked={useGlossaryAndBriefing}
          onChange={(e) => onUseGlossaryAndBriefingChange(e.target.checked)}
        />
        <span>Use profile glossary and briefing in interpretation</span>
      </label>

      {/* Profile tabs */}
      <div className="app__profile-selector">
        {profiles.map((p) => (
          <button
            key={p.id}
            type="button"
            className={`app__profile-tab${p.id === activeProfile.id ? ' app__profile-tab--active' : ''}`}
            onClick={() => {
              onActiveProfileIdChange(p.id);
              setGlossaryExpanded(false);
              setEditingGlossaryId(null);
            }}
            disabled={disabled}
          >
            {p.name}
          </button>
        ))}
        <button
          type="button"
          className="app__profile-tab app__profile-tab--add"
          onClick={addProfile}
          disabled={disabled}
          title="Add new profile"
        >
          +
        </button>
      </div>

      {/* Profile name + actions */}
      <div className="app__context-group">
        <label className="app__context-label">Profile name</label>
        <div className="app__profile-name-row">
          <input
            className="app__glossary-input app__profile-name-input"
            value={activeProfile.name}
            onChange={(e) => updateActiveProfile({ name: e.target.value })}
            disabled={disabled}
            placeholder="Profile name"
          />
          <button
            type="button"
            className="app__glossary-btn app__glossary-btn--edit"
            onClick={duplicateProfile}
            disabled={disabled}
            title="Duplicate this profile"
          >
            Duplicate
          </button>
          {profiles.length > 1 && (
            <button
              type="button"
              className="app__glossary-btn app__glossary-btn--delete"
              onClick={deleteProfile}
              disabled={disabled}
            >
              Delete
            </button>
          )}
        </div>
      </div>

      {/* Glossary */}
      <div className="app__context-group">
        <div className="app__glossary-summary-wrap">
          <button
            type="button"
            className="app__glossary-summary-btn"
            onClick={() => setGlossaryExpanded((v) => !v)}
            aria-expanded={glossaryExpanded}
          >
            <span className="app__glossary-summary-label">
              Glossary (names, acronyms, terms)
            </span>
            <span className="app__glossary-summary-count">
              {activeProfile.glossary.length}{' '}
              {activeProfile.glossary.length === 1 ? 'entry' : 'entries'}
            </span>
            <span className="app__glossary-summary-chevron" aria-hidden>
              {glossaryExpanded ? '▼' : '▶'}
            </span>
          </button>
        </div>

        {!glossaryExpanded && (
          <p className="app__context-hint">
            Click above to add or edit glossary entries for this profile.
          </p>
        )}

        {glossaryExpanded && (
          <>
            <p className="app__context-hint">Changes save automatically to this profile.</p>
            <div className="app__glossary-list">
              {activeProfile.glossary.map((entry) => (
                <div key={entry.id} className="app__glossary-row">
                  {editingGlossaryId === entry.id ? (
                    <>
                      <input
                        className="app__glossary-input"
                        value={entry.term}
                        onChange={(e) => updateGlossaryEntry(entry.id, { term: e.target.value })}
                        placeholder="Term / acronym"
                        disabled={disabled}
                      />
                      <input
                        className="app__glossary-input"
                        value={entry.meaning}
                        onChange={(e) =>
                          updateGlossaryEntry(entry.id, { meaning: e.target.value })
                        }
                        placeholder="Meaning"
                        disabled={disabled}
                      />
                      <button
                        type="button"
                        className="app__glossary-btn app__glossary-btn--save"
                        onClick={() => setEditingGlossaryId(null)}
                      >
                        Done
                      </button>
                      <button
                        type="button"
                        className="app__glossary-btn app__glossary-btn--cancel"
                        onClick={() => {
                          setEditingGlossaryId(null);
                          if (!entry.term.trim() && !entry.meaning.trim()) {
                            deleteGlossaryEntry(entry.id);
                          }
                        }}
                      >
                        Cancel
                      </button>
                    </>
                  ) : (
                    <>
                      <span className="app__glossary-term">{entry.term || '(term)'}</span>
                      <span className="app__glossary-meaning">{entry.meaning || '(meaning)'}</span>
                      <button
                        type="button"
                        className="app__glossary-btn app__glossary-btn--edit"
                        onClick={() => setEditingGlossaryId(entry.id)}
                        aria-label="Edit entry"
                        disabled={disabled}
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        className="app__glossary-btn app__glossary-btn--delete"
                        onClick={() => deleteGlossaryEntry(entry.id)}
                        aria-label="Delete entry"
                        disabled={disabled}
                      >
                        Delete
                      </button>
                    </>
                  )}
                </div>
              ))}
            </div>
            <div className="app__glossary-actions">
              <button
                type="button"
                className="app__glossary-btn app__glossary-btn--add"
                onClick={addGlossaryEntry}
                disabled={disabled}
              >
                Add entry
              </button>
            </div>
          </>
        )}
      </div>

      {/* Briefing */}
      <div className="app__context-group">
        <label className="app__context-label">Meeting briefing</label>
        <p className="app__context-hint">
          Context sent to the AI when interpretation starts (if toggle above is on). Changes save
          automatically.
        </p>
        <textarea
          className="app__context-input"
          value={activeProfile.briefing}
          onChange={(e) => updateActiveProfile({ briefing: e.target.value })}
          placeholder="Add meeting context, agenda, participants, key topics..."
          disabled={disabled}
        />
      </div>
    </details>
  );
}
