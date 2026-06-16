async function loadIncludes() {
    const includeNodes = Array.from(document.querySelectorAll("[data-include]"));

    await Promise.all(includeNodes.map(async (node) => {
        const path = node.getAttribute("data-include");
        const response = await fetch(path);

        if (!response.ok) {
            throw new Error(`Failed to load ${path}`);
        }

        node.innerHTML = await response.text();
    }));
}

function setupModals() {
    const modalTriggers = document.querySelectorAll("[data-modal-target]");

    modalTriggers.forEach((trigger) => {
        trigger.addEventListener("click", () => {
            const modal = document.getElementById(trigger.getAttribute("data-modal-target"));
            if (modal) {
                modal.style.display = "block";
            }
        });
    });

    document.querySelectorAll(".modal").forEach((modal) => {
        const closeButton = modal.querySelector(".close");

        if (closeButton) {
            closeButton.addEventListener("click", () => {
                modal.style.display = "none";
            });
        }

        modal.addEventListener("click", (event) => {
            if (event.target === modal) {
                modal.style.display = "none";
            }
        });
    });
}

document.addEventListener("DOMContentLoaded", async () => {
    try {
        await loadIncludes();
        setupModals();
    } catch (error) {
        console.error(error);
        document.body.insertAdjacentHTML(
            "afterbegin",
            '<div style="padding:16px;background:#fff3cd;color:#664d03;font-family:Arial,sans-serif;">Page fragments could not load. Run this site from GitHub Pages or a local web server, not directly from file://.</div>'
        );
    }
});
