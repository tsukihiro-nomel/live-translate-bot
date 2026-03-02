(() => {
  const stack = document.getElementById('stack');
  const params = new URLSearchParams(window.location.search);
  const token = params.get('token');
  const guildFilter = params.get('guild');

  const state = {
    speakers: new Map(), // id -> speaker
    bubbles: new Map(), // speakerId -> { el, timers }
    holdMs: 2500,
    removeMs: 12000
  };

  function hashToHue(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    // 0..359
    return Math.abs(h) % 360;
  }

  function pastelAccent(speakerId) {
    const hue = hashToHue(speakerId);
    // Pastel-ish HSL
    return `hsl(${hue} 55% 78%)`;
  }

  function ensureBubble(speakerId) {
    if (state.bubbles.has(speakerId)) return state.bubbles.get(speakerId);

    const speaker = state.speakers.get(speakerId) || { id: speakerId, name: '???', avatar: null };
    const el = document.createElement('div');
    el.className = 'bubble';
    el.dataset.speakerId = speakerId;

    const accent = pastelAccent(speakerId);
    el.style.setProperty('--accent', accent);
    el.setAttribute('data-accent', '1');

    const avatar = document.createElement('div');
    avatar.className = 'avatar';
    if (speaker.avatar) {
      const img = document.createElement('img');
      img.alt = speaker.name;
      img.src = speaker.avatar;
      avatar.appendChild(img);
    }

    const content = document.createElement('div');
    content.className = 'content';

    const name = document.createElement('p');
    name.className = 'name';
    name.textContent = speaker.name;

    const text = document.createElement('p');
    text.className = 'text';
    text.textContent = '';

    content.appendChild(name);
    content.appendChild(text);

    el.appendChild(avatar);
    el.appendChild(content);

    // Fixed order: append once. (Speakers stack upward.)
    stack.appendChild(el);

    const bubble = {
      el,
      nameEl: name,
      textEl: text,
      timers: { hold: null, remove: null }
    };

    state.bubbles.set(speakerId, bubble);
    return bubble;
  }

  function setSpeaking(bubble) {
    bubble.el.classList.add('speaking');
    bubble.el.classList.remove('cooldown', 'leaving');

    if (bubble.timers.hold) clearTimeout(bubble.timers.hold);
    if (bubble.timers.remove) clearTimeout(bubble.timers.remove);

    bubble.timers.hold = setTimeout(() => {
      bubble.el.classList.remove('speaking');
      bubble.el.classList.add('cooldown');
    }, state.holdMs);

    bubble.timers.remove = setTimeout(() => {
      bubble.el.classList.add('leaving');
      setTimeout(() => {
        bubble.el.remove();
        state.bubbles.delete(bubble.el.dataset.speakerId);
      }, 700);
    }, state.removeMs);
  }

  function updateSpeaker(speaker) {
    if (!speaker?.id) return;
    state.speakers.set(speaker.id, speaker);

    const bubble = state.bubbles.get(speaker.id);
    if (!bubble) return;
    bubble.nameEl.textContent = speaker.name || bubble.nameEl.textContent;

    // update avatar
    const avatarDiv = bubble.el.querySelector('.avatar');
    if (avatarDiv) {
      avatarDiv.innerHTML = '';
      if (speaker.avatar) {
        const img = document.createElement('img');
        img.alt = speaker.name;
        img.src = speaker.avatar;
        avatarDiv.appendChild(img);
      }
    }
  }

  function handleCaption(ev) {
    if (guildFilter && ev.guildId && ev.guildId !== guildFilter) return;

    const speaker = ev.speaker;
    if (speaker?.id) state.speakers.set(speaker.id, speaker);

    const speakerId = speaker?.id || ev.speakerId;
    if (!speakerId) return;

    const bubble = ensureBubble(speakerId);
    if (speaker?.name) bubble.nameEl.textContent = speaker.name;

    if (typeof ev.text === 'string' && ev.text.trim()) {
      bubble.textEl.textContent = ev.text.trim();
      setSpeaking(bubble);
    }
  }

  function handleInit(ev) {
    if (ev?.config) {
      if (typeof ev.config.holdMs === 'number') state.holdMs = ev.config.holdMs;
      if (typeof ev.config.removeMs === 'number') state.removeMs = ev.config.removeMs;
    }

    (ev.speakers || []).forEach((s) => updateSpeaker(s));

    // Rehydrate last captions
    (ev.captions || []).forEach((c) => {
      const speakerId = c.speakerId;
      if (!speakerId) return;
      const bubble = ensureBubble(speakerId);
      bubble.textEl.textContent = c.text || '';
      // put it in cooldown state (not actively speaking)
      bubble.el.classList.add('cooldown');
      setSpeaking(bubble); // will schedule fade out with hold/remove
    });
  }

  let retryMs = 1000;

  function connect() {
    if (!token) {
      console.warn('Overlay: missing token in URL. Add ?token=...');
    }

    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const qs = new URLSearchParams();
    qs.set('token', token || '');
    if (guildFilter) qs.set('guild', guildFilter);
    const wsUrl = `${proto}//${window.location.host}/ws?${qs.toString()}`;
    const ws = new WebSocket(wsUrl);

    ws.addEventListener('open', () => {
      retryMs = 1000;
      console.log('Overlay WS connected');
    });

    ws.addEventListener('close', () => {
      console.log('Overlay WS disconnected; retrying...');
      setTimeout(connect, retryMs);
      retryMs = Math.min(10_000, retryMs * 2);
    });

    ws.addEventListener('message', (msg) => {
      let ev;
      try {
        ev = JSON.parse(msg.data);
      } catch {
        return;
      }

      switch (ev.type) {
        case 'state.init':
          handleInit(ev);
          break;
        case 'speaker.update':
          updateSpeaker(ev.speaker);
          break;
        case 'caption.interim':
        case 'caption.final':
          handleCaption(ev);
          break;
        case 'speaker.activity':
          // optional: could use to highlight even before caption
          break;
        default:
          break;
      }
    });
  }

  connect();
})();
