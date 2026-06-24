// Thin WebSocket client with auto-reconnect (mirrors the proxy's backoff pattern).
// `path` selects the endpoint: '/ws' (design) or '/ws-visualizer' (deployed state).
export function createSocket(onMessage, onStatusChange, path = '/ws') {
    let socket = null;
    let retryDelay = 1000;
    let closedByUser = false;

    function connect() {
        const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
        socket = new WebSocket(`${protocol}://${window.location.host}${path}`);

        socket.addEventListener('open', () => {
            retryDelay = 1000;
            onStatusChange(true);
        });

        socket.addEventListener('message', (event) => {
            try {
                onMessage(JSON.parse(event.data));
            } catch {
                // ignore malformed frames
            }
        });

        socket.addEventListener('close', () => {
            onStatusChange(false);
            if (!closedByUser) {
                setTimeout(connect, retryDelay);
                retryDelay = Math.min(retryDelay * 2, 30000);
            }
        });
    }

    connect();

    return {
        send(message) {
            if (socket && socket.readyState === WebSocket.OPEN) {
                socket.send(JSON.stringify(message));
                return true;
            }
            return false;
        },
        close() {
            closedByUser = true;
            socket?.close();
        }
    };
}
