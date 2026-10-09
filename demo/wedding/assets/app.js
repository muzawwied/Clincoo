// --- Navbar Scroll Effect ---
        const navbar = document.getElementById('navbar');
        window.addEventListener('scroll', () => {
            if (window.scrollY > 50) {
                navbar.classList.add('bg-white', 'text-wedding-dark', 'shadow-sm');
                navbar.classList.remove('text-white', 'py-6');
                navbar.classList.add('py-4');
                const links = navbar.querySelectorAll('a');
                links.forEach(link => {
                    link.classList.remove('text-white');
                    link.classList.add('hover:text-wedding-accent');
                });
                navbar.querySelector('a[href="#home"]').classList.remove('text-white');
                navbar.querySelector('a[href="#home"]').classList.add('text-wedding-dark');
                navbar.querySelector('a[href="#rsvp"]').classList.remove('hover:border-white');
                navbar.querySelector('a[href="#rsvp"]').classList.add('hover:border-wedding-dark');
            } else {
                navbar.classList.remove('bg-white', 'text-wedding-dark', 'shadow-sm', 'py-4');
                navbar.classList.add('text-white', 'py-6');
                const links = navbar.querySelectorAll('a');
                links.forEach(link => {
                    link.classList.add('text-white');
                });
                navbar.querySelector('a[href="#home"]').classList.add('text-white');
                navbar.querySelector('a[href="#home"]').classList.remove('text-wedding-dark');
                navbar.querySelector('a[href="#rsvp"]').classList.add('hover:border-white');
                navbar.querySelector('a[href="#rsvp"]').classList.remove('hover:border-wedding-dark');
            }
        });

        // --- Intersection Observer for Fade-Up Reveal ---
        const revealElements = document.querySelectorAll('.reveal');
        const revealOptions = {
            threshold: 0.15,
            rootMargin: "0px 0px -50px 0px"
        };
        const revealOnScroll = new IntersectionObserver(function(entries, observer) {
            entries.forEach(entry => {
                if (!entry.isIntersecting) {
                    return;
                } else {
                    entry.target.classList.add('active');
                    observer.unobserve(entry.target);
                }
            });
        }, revealOptions);

        revealElements.forEach(el => {
            revealOnScroll.observe(el);
        });

        // --- Countdown Logic ---
        const countDownDate = new Date("Oct 24, 2026 08:00:00").getTime();
        const x = setInterval(function() {
            const now = new Date().getTime();
            const distance = countDownDate - now;

            const days = Math.floor(distance / (1000 * 60 * 60 * 24));
            const hours = Math.floor((distance % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
            const minutes = Math.floor((distance % (1000 * 60 * 60)) / (1000 * 60));
            const seconds = Math.floor((distance % (1000 * 60)) / 1000);

            document.getElementById("days").innerHTML = days < 10 ? "0" + days : days;
            document.getElementById("hours").innerHTML = hours < 10 ? "0" + hours : hours;
            document.getElementById("minutes").innerHTML = minutes < 10 ? "0" + minutes : minutes;
            document.getElementById("seconds").innerHTML = seconds < 10 ? "0" + seconds : seconds;

            if (distance < 0) {
                clearInterval(x);
                document.getElementById("days").innerHTML = "00";
                document.getElementById("hours").innerHTML = "00";
                document.getElementById("minutes").innerHTML = "00";
                document.getElementById("seconds").innerHTML = "00";
            }
        }, 1000);

        // --- Copy to Clipboard Logic ---
        function copyToClipboard(text, btnElement) {
            const el = document.createElement('textarea');
            el.value = text;
            document.body.appendChild(el);
            el.select();
            document.execCommand('copy');
            document.body.removeChild(el);
            
            const originalText = btnElement.innerText;
            btnElement.innerText = "Copied!";
            btnElement.classList.add("bg-wedding-accent", "text-white");
            
            setTimeout(() => {
                btnElement.innerText = originalText;
                btnElement.classList.remove("bg-wedding-accent", "text-white");
            }, 2000);
        }

        // --- Background Music Simulation ---
        let isPlaying = false;
        const bgMusic = document.getElementById('bgMusic');
        const musicIcon = document.getElementById('musicIcon');
        const musicText = document.getElementById('musicText');

        function toggleMusic() {
            if (!isPlaying) {
                bgMusic.play().catch(() => {});
                isPlaying = true;
                musicIcon.innerText = "❚❚";
                musicText.innerText = "Music: On";
            } else {
                bgMusic.pause();
                isPlaying = false;
                musicIcon.innerText = "♫";
                musicText.innerText = "Music: Off";
            }
        }

        // --- Form RSVP Mock Submit ---
        function submitRSVP(e) {
            e.preventDefault();
            const name = document.getElementById('name').value;
            const message = document.getElementById('message').value;
            const successMsg = document.getElementById('rsvpSuccess');
            successMsg.classList.remove('hidden');
            
            if(message.trim() !== "") {
                const container = document.getElementById('wishesContainer');
                const newWish = document.createElement('div');
                newWish.className = "border-b border-wedding-accent/20 pb-4 reveal active opacity-0 transition-opacity duration-1000";
                newWish.innerHTML = `
                    <p class="font-medium text-sm text-wedding-dark mb-1">${name}</p>
                    <p class="text-xs text-wedding-muted font-light">${message}</p>
                `;
                container.insertBefore(newWish, container.firstChild);
                setTimeout(() => {
                    newWish.classList.remove('opacity-0');
                    newWish.classList.add('opacity-100');
                }, 100);
            }
            
            document.getElementById('rsvpForm').reset();
            setTimeout(() => {
                successMsg.classList.add('hidden');
            }, 5000);
        }
