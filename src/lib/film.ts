/** True on the film route (?film, ?film=<id>): product copy there leaves out the integration vendors' names. */
export const FILM = typeof window !== 'undefined' && /[?&]film(=|&|$)/.test(window.location.search);
