/* Klaud site — Progressive enhancements & micro-interactions */

(function () {
  'use strict';

  /* ---------- Scroll Reveal Progressive Enhancement ---------- */
  var revealables = Array.prototype.slice.call(document.querySelectorAll('.reveal'));
  var reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  if (!('IntersectionObserver' in window) || reduced) {
    revealables.forEach(function (el) { el.classList.add('is-visible'); });
  } else {
    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        var el = entry.target;
        var siblings = el.parentElement ? Array.prototype.slice.call(el.parentElement.children) : [];
        var index = siblings.indexOf(el);
        el.style.transitionDelay = Math.min(index > -1 ? index * 60 : 0, 300) + 'ms';
        el.classList.add('is-visible');
        observer.unobserve(el);
      });
    }, { rootMargin: '0px 0px -6% 0px', threshold: 0.08 });

    revealables.forEach(function (el) { observer.observe(el); });
  }

  /* ---------- Header Shadow & Active Section Spying ---------- */
  var header = document.querySelector('.site-header');
  var navLinks = Array.prototype.slice.call(document.querySelectorAll('.site-nav a'));
  var sections = Array.prototype.slice.call(document.querySelectorAll('section[id]'));

  /* ---------- Mobile Navigation Panel ---------- */
  var navToggle = document.querySelector('.nav-toggle');
  var siteNav = document.getElementById('site-nav');

  var setNavOpen = function (open) {
    if (!navToggle || !siteNav) return;
    navToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    navToggle.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
    siteNav.classList.toggle('is-open', open);
  };

  if (navToggle && siteNav) {
    navToggle.addEventListener('click', function () {
      setNavOpen(navToggle.getAttribute('aria-expanded') !== 'true');
    });

    navLinks.forEach(function (link) {
      link.addEventListener('click', function () { setNavOpen(false); });
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') setNavOpen(false);
    });

    window.addEventListener('resize', function () {
      if (window.innerWidth > 860) setNavOpen(false);
    });
  }

  var onScroll = function () {
    var scrollY = window.scrollY || window.pageYOffset || 0;
    if (header) {
      header.classList.toggle('is-scrolled', scrollY > 12);
    }

    /* Active section highlight */
    if (sections.length && navLinks.length) {
      var currentId = '';
      for (var i = 0; i < sections.length; i++) {
        var sec = sections[i];
        var top = sec.offsetTop - 120;
        var height = sec.offsetHeight;
        if (scrollY >= top && scrollY < top + height) {
          currentId = '#' + sec.getAttribute('id');
          break;
        }
      }
      navLinks.forEach(function (link) {
        var active = link.getAttribute('href') === currentId;
        link.classList.toggle('is-active', active);
        if (active) link.setAttribute('aria-current', 'true');
        else link.removeAttribute('aria-current');
      });
    }
  };

  onScroll();
  window.addEventListener('scroll', onScroll, { passive: true });

  /* ---------- Copy to Clipboard with Feedback ---------- */
  Array.prototype.slice.call(document.querySelectorAll('[data-copy]')).forEach(function (btn) {
    btn.addEventListener('click', function () {
      var text = btn.getAttribute('data-copy') || '';
      var label = btn.querySelector('.copy-label');
      var originalLabel = label ? label.textContent : '';

      var done = function () {
        btn.classList.add('is-copied');
        if (label) label.textContent = 'copied!';
        window.setTimeout(function () {
          btn.classList.remove('is-copied');
          if (label) label.textContent = originalLabel || 'copy';
        }, 1800);
      };

      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, function () {
          fallbackCopy(text, done);
        });
      } else {
        fallbackCopy(text, done);
      }
    });
  });

  function fallbackCopy(text, callback) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
    } catch (e) {
      /* ignore */
    }
    document.body.removeChild(ta);
    if (callback) callback();
  }
})();
