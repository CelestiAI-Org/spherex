(() => {
    const panel = document.getElementById('target-panel');
    const toggle = document.getElementById('menu-toggle');
    const mode = document.getElementById('search-mode');
    const name = document.getElementById('target-name');
    const coordinates = document.getElementById('coordinate-fields');
    const status = document.getElementById('status');

    toggle.addEventListener('click', () => {
        panel.hidden = !panel.hidden;
        toggle.setAttribute('aria-expanded', String(!panel.hidden));
    });

    function updateMode() {
        const byCoordinates = mode.value === 'coordinates';
        document.getElementById('name-fields').hidden = byCoordinates;
        name.disabled = byCoordinates;
        coordinates.hidden = !byCoordinates;
        coordinates.disabled = !byCoordinates;
    }
    mode.addEventListener('change', updateMode);
    updateMode();

    document.getElementById('target-form').addEventListener('submit', event => {
        event.preventDefault();
        if (mode.value === 'name' && !name.value.trim()) {
            name.setCustomValidity('Enter a target name.');
            name.reportValidity();
            return;
        }

    });
    name.addEventListener('input', () => name.setCustomValidity(''));
    document.getElementById('back-to-sky').addEventListener('click', () => {
        document.getElementById('viewer').hidden = true;
    });
})();

