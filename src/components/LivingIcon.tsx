export function LivingIcon({ name }: { name: string }) {
  const paths: Record<string, string> = {
    eye: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12ZM15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0',
    fruit: 'M12 7c-7-5-12 3-8 10s8 3 8 3 4 4 8-3-1-15-8-10ZM12 7c0-4 2-5 5-5-1 4-3 5-5 5Z',
    tree: 'M12 3 5 10h3l-5 6h7v5h4v-5h7l-5-6h3L12 3Z',
    fire: 'M13 2c1 7-7 6-7 13a6 6 0 0 0 12 0c0-3-2-6-3-7 0 4-3 5-3 5 2-5 2-7 1-11Z',
    flower: 'M12 10C3 0 0 10 9 12 0 21 11 24 12 15c7 10 14 2 3-3 11-5 5-13-3-2ZM12 15v7m0-3 5-2',
    camera: 'M3 7h4l2-3h6l2 3h4v13H3V7ZM16 13a4 4 0 1 1-8 0 4 4 0 0 1 8 0',
    album: 'M4 3h16v18H4V3Zm0 12 5-5 5 6 3-3 3 4M15 7h1',
    book: 'M12 5C8 2 3 3 3 3v16s5-1 9 2c4-3 9-2 9-2V3s-5-1-9 2Zm0 0v16',
    sun: 'M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0ZM12 1v3m0 16v3M1 12h3m16 0h3M4 4l2 2m12 12 2 2M4 20l2-2M18 6l2-2',
    dusk: 'M3 17h18M6 21h12M6 14a6 6 0 0 1 12 0M12 2v3M3 6l2 2m14 0 2-2',
    close: 'm6 6 12 12M18 6 6 18', more: 'M4 12h1m6 0h1m6 0h1',
    reset: 'M3 10a9 9 0 1 1 2 8M3 4v6h6', pause: 'M8 5v14M16 5v14', play: 'm7 4 13 8-13 8V4Z',
    download: 'M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5', heart: 'M12 20C-5 10 5-3 12 7c7-10 17 3 0 13Z',
  };
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d={paths[name] ?? paths.eye} /></svg>;
}
