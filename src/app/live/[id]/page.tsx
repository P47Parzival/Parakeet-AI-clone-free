import { LiveView } from "./LiveView";

/**
 * Read-only copilot view meant for a second device — a phone propped next to the laptop.
 * Nothing here is on the screen you share, so no screen share can ever reveal it.
 */
export default async function LivePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <LiveView id={id} />;
}
