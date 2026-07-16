import { useDeployed } from '../DeployedContext.js';

// Metadata + destructive actions for the selected chat (name/mode/dates/id + delete).
// Same content that used to render as a strip under the toolbar, now a dockable panel.
export default function DetailsPanel() {
    const {
        selectedChat, deployed, mixed, divergentCount, resources,
        editingName, setEditingName, renameValue, setRenameValue,
        renameChat, cancelRename, startRename, formatDate, copy, copied,
        confirmDelete, setConfirmDelete, deleteChat, deleting
    } = useDeployed();

    if (!selectedChat) {
        return <div className="dv-pane dv-pane-empty">Select a sigil to see its details.</div>;
    }

    return (
        <div className="dv-pane chat-details" role="region" aria-label="Sigil details">
            <div className="chat-details-row">
                <label htmlFor={editingName ? 'chat-name' : undefined}>Name</label>
                {editingName ? (
                    <span className="chat-details-edit">
                        <input
                            id="chat-name"
                            type="text"
                            autoFocus
                            placeholder="Session name"
                            value={renameValue}
                            onChange={(e) => setRenameValue(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter') renameChat();
                                if (e.key === 'Escape') cancelRename();
                            }}
                        />
                        <button type="button" className="btn btn-primary" onClick={renameChat}>Save</button>
                        <button type="button" className="link-btn" onClick={cancelRename}>Cancel</button>
                    </span>
                ) : (
                    <span className="chat-details-value chat-details-inline">
                        <span className="chat-details-name-text">{selectedChat.name || 'Untitled'}</span>
                        <button type="button" className="link-btn" onClick={startRename}>Rename</button>
                    </span>
                )}
            </div>
            <div className="chat-details-row">
                <label>Mode</label>
                <span className="chat-details-value chat-details-inline">
                    <span className={`badge ${deployed ? 'badge-deployed' : 'badge-preview'}`}>
                        {deployed ? 'Live' : 'Design'}
                    </span>
                    <span className="chat-details-mode-hint">
                        {deployed ? 'Deployed to AWS' : 'Not deployed — a design sketch'}
                    </span>
                </span>
            </div>
            {mixed && (
                <div className="chat-details-row">
                    <label>Consistency</label>
                    <span className="chat-details-value chat-details-inline details-mixed">
                        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor"
                            strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                            <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                            <line x1="12" y1="9" x2="12" y2="13" />
                            <line x1="12" y1="17" x2="12.01" y2="17" />
                        </svg>
                        <span>
                            {divergentCount} of {resources.length} resource{resources.length === 1 ? '' : 's'}{' '}
                            {deployed
                                ? 'not deployed to AWS yet — marked on the diagram.'
                                : 'already deployed to AWS — marked on the diagram.'}
                        </span>
                    </span>
                </div>
            )}
            <div className="chat-details-row">
                <label>Created</label>
                <span className="chat-details-value">{formatDate(selectedChat.createdAt)}</span>
            </div>
            <div className="chat-details-row">
                <label>Last update</label>
                <span className="chat-details-value">{formatDate(selectedChat.updatedAt)}</span>
            </div>
            <div className="chat-details-row">
                <label>Sigil ID</label>
                <span className="chat-details-value chat-details-inline">
                    <span className="chat-details-id-text">{selectedChat.chatId}</span>
                    <button
                        type="button"
                        className={`link-btn ${copied === 'cid' ? 'is-copied' : ''}`}
                        onClick={() => copy(selectedChat.chatId, 'cid')}
                    >
                        {copied === 'cid' ? 'Copied' : 'Copy'}
                    </button>
                </span>
            </div>
            <div className="chat-details-row chat-details-danger">
                <label>Danger zone</label>
                {confirmDelete ? (
                    <span className="chat-details-value chat-details-inline">
                        <span>Delete this sigil permanently?</span>
                        <button
                            type="button"
                            className="link-btn token-danger"
                            onClick={deleteChat}
                            disabled={deleting}
                        >
                            {deleting ? 'Deleting…' : 'Delete'}
                        </button>
                        <button type="button" className="link-btn" onClick={() => setConfirmDelete(false)}>Cancel</button>
                    </span>
                ) : (
                    <span className="chat-details-value">
                        <button
                            type="button"
                            className="btn btn-danger"
                            onClick={() => setConfirmDelete(true)}
                        >
                            Delete sigil
                        </button>
                    </span>
                )}
            </div>
        </div>
    );
}
