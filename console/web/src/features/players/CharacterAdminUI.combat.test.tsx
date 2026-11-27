import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CharacterAdminUI } from './CharacterAdminUI';
import { setConsoleAccess } from '../../lib/consoleAccess';

vi.mock('./CombatPanel', () => ({ CombatPanel: ({ controllerId }: { controllerId?: string }) => <div>Controller: {controllerId}</div> }));
vi.mock('./PlayerSummary', () => ({ PlayerSummary: () => <div>Summary</div> }));
vi.mock('./PlayerDetailTab', () => ({ PlayerDetailTab: () => <div>Inventory</div> }));

function renderCharacter(controllerId?: string) {
  render(<CharacterAdminUI detail={{ player: { player_controller_id: controllerId }, capabilities: {} }} fallback={{}}
    dbPlayerId="1" actionPlayerId="synthetic" playerName="Test Player" onError={vi.fn()} onRefresh={vi.fn()}
    onClose={vi.fn()} confirmAction={vi.fn()} waitForTask={vi.fn()} formatMutationResult={() => ''} restartGate={vi.fn()} />);
}
function open(controllerId?: string) {
  renderCharacter(controllerId);
  fireEvent.click(screen.getByRole('button', { name: 'Combat' }));
}

describe('character Combat tab', () => {
  it('keeps Combat readable without granting character mutation controls', () => {
    setConsoleAccess('ready', { username: 'moderator', displayName: 'Moderator', tier: 'moderator' }, ['players:read']);
    open('101');
    expect(screen.getByText('Controller: 101')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Admin' })).toBeNull();
  });
  it('hides Combat when the account lacks player read access', () => {
    setConsoleAccess('ready', { username: 'moderator', displayName: 'Moderator', tier: 'moderator' }, ['players:moderate']);
    renderCharacter('101');
    expect(screen.queryByRole('button', { name: 'Combat' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Admin' })).toBeInTheDocument();
  });
  it('uses the authoritative controller rather than the character or pawn ID', () => {
    open('101');
    expect(screen.getByText('Controller: 101')).toBeInTheDocument();
  });
  it.each([undefined, '0'])('never falls back to a global query for a character without a valid controller (%s)', controllerId => {
    open(controllerId);
    expect(screen.getByText('Combat history is not available for this character.')).toBeInTheDocument();
    expect(screen.queryByText(/^Controller:/)).not.toBeInTheDocument();
  });
});
