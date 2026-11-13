import { get, errorText } from './api.js';
import * as player from './player.js';
import { toast } from './ui.js';

async function withTracks(url, pick, opts) {
  try {
    const data = await get(url);
    const tracks = pick(data);
    if (!tracks.some((t) => t.ready)) { toast('Todavía no hay canciones listas para escuchar.'); return; }
    player.playTracks(tracks, 0, opts);
  } catch (e) { toast(errorText(e)); }
}
export const playAlbum = (id, opts = { shuffle: false }) => withTracks(`/api/albums/${id}`, (d) => d.tracks, opts);
export const playArtist = (id, opts = { shuffle: false }) => withTracks(`/api/artists/${id}`, (d) => d.tracks, opts);
export const playPlaylist = (id, opts = { shuffle: false }) => withTracks(`/api/playlists/${id}`, (d) => d.tracks, opts);
export const playEverything = () => withTracks('/api/shuffle', (d) => d.tracks, { shuffle: true });
