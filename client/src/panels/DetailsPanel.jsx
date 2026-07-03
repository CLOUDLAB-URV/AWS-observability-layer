import { useDeployed } from '../DeployedContext.js';

// Metadata + destructive actions for the selected chat (name/mode/dates/id + delete).
// Same content that used to render as a strip under the toolbar, now a dockable panel.
export default function DetailsPanel() {
    const {
        selectedChat, deployed, editingName, setEditingName, renameValue, setRenameValue,
        renameChat, cancelRename, startRename, formatDate, copy, copied,
        confirmDelete, setConfirmDelete, deleteChat, deleting
    } = useDeployed();

    if (!selectedChat) {
        return <div className="dv-pane dv-pane-empty">Select a chat to see its details.</div>;
    }

    return (
        <div className="dv-pane chat-details" role="region" aria-label="Chat details">
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
                        <button type="button" className="details-save-btn" onClick={renameChat}>Save</button>
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
            <div className="chat-details-row">
                <label>Created</label>
                <span className="chat-details-value">{formatDate(selectedChat.createdAt)}</span>
            </div>
            <div className="chat-details-row">
                <label>Last update</label>
                <span className="chat-details-value">{formatDate(selectedChat.updatedAt)}</span>
            </div>
            <div className="chat-details-row">
                <label>Chat ID</label>
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
                        <span>Delete this diagram permanently?</span>
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
                            className="details-danger-btn"
                            onClick={() => setConfirmDelete(true)}
                        >
                            Delete diagram
                        </button>
                    </span>
                )}
            </div>
        </div>
    );
}
