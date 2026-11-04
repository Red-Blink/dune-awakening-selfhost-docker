// #676 §7: the guided Tier 4 -> 1 migration's "offer" screen. Shown at most
// once, after a first-time Discord OAuth configuration (with TOTP already
// enrolled) is followed by a real Discord sign-in -- see App.tsx's
// discordOfferMode / DISCORD_OFFER_MARKER for the full trigger condition and
// why this has to live here rather than as a DiscordSetupWizard step (a
// Layer 1 audit finding: the wizard's own restart ends in a full page
// navigation that unmounts it before this point is ever reached).
//
// Deliberately simpler than the original design's two-branch copy: rather
// than duplicating the zero-2FA guard's "does Discord's MFA cover this
// tier" logic here too, this screen only ever offers ONE path -- into
// Settings' Two-Factor section, auto-opened -- where the real, single-
// source-of-truth guard (totpDisableRoute's own 409) already handles both
// outcomes correctly. Two copies of that decision would be exactly the kind
// of drift this project's own history warns against.
type Props = {
  onReview: () => void;
  onDismiss: () => void;
};

export function DiscordMigrationOffer({ onReview, onDismiss }: Props) {
  return (
    <main className="login-screen">
      <section className="login-panel discord-setup-panel">
        <h1>Discord sign-in is connected</h1>
        <p className="muted">
          You just signed in with Discord for the first time on this console. Since your password login also has
          two-factor authentication turned on, you may want to review whether you still need both.
        </p>
        <p className="muted">
          Your password stays available as a fallback either way &mdash; this is only about its own separate
          two-factor code, which is unrelated to Discord sign-in.
        </p>
        <button type="button" className="login-primary-button" onClick={onReview}>Review Two-Factor Settings</button>
        <button type="button" className="login-password-toggle" onClick={onDismiss}>Not now</button>
      </section>
    </main>
  );
}
