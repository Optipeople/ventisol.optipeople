// Shown inside the settings frame while a section loads, so the header and
// the sub-navigation stay in place when moving between sections.
export default function SettingsLoading() {
  return (
    <div className="animate-pulse" aria-busy="true" aria-label="Indlæser">
      <div className="h-[64px] rounded-[2px] bg-[var(--ds-grey-light-02)]" />
      <div className="mt-6 h-[260px] rounded-[2px] bg-[var(--ds-grey-light-02)]" />
    </div>
  );
}
