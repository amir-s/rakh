export default function PaneEmptyState({ message }: { message: string }) {
  return (
    <div className="artifact-tab-content">
      <p className="artifact-pane-empty">{message}</p>
    </div>
  );
}
