import { TARGETS } from './target-catalogue.js';

(() => {
    const panel = document.getElementById('target-panel');
    const toggle = document.getElementById('menu-toggle');
    const mode = document.getElementById('search-mode');
    const name = document.getElementById('target-name');
    const coordinates = document.getElementById('coordinate-fields');
    const options = document.getElementById('target-options');
    const noMatches = document.getElementById('target-no-matches');
    const modeButtons = [...document.querySelectorAll('[data-search-mode]')];
    let matches = [], active = -1;
    const normalize = value => value.toLowerCase().replace(/[^a-z0-9+]/g, '');

    function closeOptions() {
        options.hidden = noMatches.hidden = true;
        name.setAttribute('aria-expanded', 'false');
        name.removeAttribute('aria-activedescendant');
        active = -1;
    }
    function highlight(index) {
        active = index;
        [...options.children].forEach((option, i) => option.setAttribute('aria-selected', String(i === index)));
        if (index >= 0) {
            name.setAttribute('aria-activedescendant', options.children[index].id);
            options.children[index].scrollIntoView({ block: 'nearest' });
        } else name.removeAttribute('aria-activedescendant');
    }
    function choose(target) {
        name.value = target.name;
        name.setCustomValidity('');
        closeOptions();
    }
    function showOptions(query = '') {
        const q = normalize(query);
        matches = TARGETS.filter(target => [target.name, target.key, ...target.aliases].some(value => normalize(value).includes(q)));
        options.replaceChildren(...matches.map(target => {
            const option = document.createElement('div');
            option.id = `target-option-${target.key}`;
            option.setAttribute('role', 'option');
            option.setAttribute('aria-selected', 'false');
            option.textContent = target.name;
            option.addEventListener('pointerdown', event => event.preventDefault());
            option.addEventListener('click', () => choose(target));
            return option;
        }));
        options.hidden = false;
        noMatches.hidden = matches.length > 0;
        name.setAttribute('aria-expanded', 'true');
        highlight(-1);
    }
    name.addEventListener('focus', () => showOptions());
    name.addEventListener('click', () => { if (options.hidden) showOptions(); });
    name.addEventListener('input', () => { name.setCustomValidity(''); showOptions(name.value); });
    name.addEventListener('blur', closeOptions);
    name.addEventListener('keydown', event => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            if (options.hidden) showOptions(name.value);
            if (matches.length) {
                const step = event.key === 'ArrowDown' ? 1 : -1;
                highlight(active < 0 ? (step > 0 ? 0 : matches.length - 1) : (active + step + matches.length) % matches.length);
            }
        } else if (event.key === 'Enter' && !options.hidden && active >= 0) {
            event.preventDefault();
            choose(matches[active]);
        } else if (event.key === 'Escape' && !options.hidden) {
            event.preventDefault();
            event.stopPropagation();
            closeOptions();
        }
    });

    toggle.addEventListener('click', () => {
        panel.hidden = !panel.hidden;
        toggle.setAttribute('aria-expanded', String(!panel.hidden));
        closeOptions();
    });

    function updateMode() {
        const byCoordinates = mode.value === 'coordinates';
        document.getElementById('name-fields').hidden = byCoordinates;
        name.disabled = byCoordinates;
        coordinates.hidden = !byCoordinates;
        coordinates.disabled = !byCoordinates;
        modeButtons.forEach(button => button.setAttribute('aria-pressed', String(button.dataset.searchMode === mode.value)));
        closeOptions();
    }
    modeButtons.forEach(button => button.addEventListener('click', () => {
        mode.value = button.dataset.searchMode;
        mode.dispatchEvent(new Event('change'));
    }));
    mode.addEventListener('change', updateMode);
    updateMode();

    document.getElementById('target-form').addEventListener('submit', event => {
        event.preventDefault();
        closeOptions();
        if (mode.value === 'name' && !name.value.trim()) {
            name.setCustomValidity('Enter a target name.');
            name.reportValidity();
        }
    });
})();
