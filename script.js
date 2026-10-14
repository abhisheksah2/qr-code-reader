  tailwind.config = {
      darkMode: 'class',
      theme: {
        extend: {
          fontFamily: {
            sans: ['Inter', 'sans-serif'],
          },
          colors: {
            brand: {
              50: '#eef2ff',
              100: '#e0e7ff',
              500: '#6366f1',
              600: '#4f46e5',
              700: '#4338ca',
            }
          },
          animation: {
            'scan-line': 'scan 2.2s ease-in-out infinite alternate',
            'pulse-subtle': 'pulse 2.5s cubic-bezier(0.4, 0, 0.6, 1) infinite',
          },
          keyframes: {
            scan: {
              '0%': { transform: 'translateY(8%)', opacity: '0.4' },
              '50%': { opacity: '1' },
              '100%': { transform: 'translateY(92%)', opacity: '0.4' },
            }
          }
        }
      }
    }
    /* Global Application State */
    const STATE = {
      html5QrCode: null,
      isScanning: false,
      activeCameraId: null,
      availableCameras: [],
      soundEnabled: true,
      torchEnabled: false,
      history: JSON.parse(localStorage.getItem('omniscan_history') || '[]'),
      lastScannedData: null,
      lastScannedTimestamp: 0,
      audioCtx: null
    };

    /* Initialize Web Audio API for feedback chirp */
    function playBeep() {
      if (!STATE.soundEnabled) return;
      try {
        if (!STATE.audioCtx) {
          STATE.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        }
        if (STATE.audioCtx.state === 'suspended') {
          STATE.audioCtx.resume();
        }
        const osc = STATE.audioCtx.createOscillator();
        const gain = STATE.audioCtx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(880, STATE.audioCtx.currentTime); // A5 note
        gain.gain.setValueAtTime(0.12, STATE.audioCtx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, STATE.audioCtx.currentTime + 0.15);
        osc.connect(gain);
        gain.connect(STATE.audioCtx.destination);
        osc.start();
        osc.stop(STATE.audioCtx.currentTime + 0.15);
      } catch (err) {
        console.warn('Audio playback error', err);
      }
    }

    /* Helper: Show Floating Toast */
    function showToast(message) {
      const toast = document.getElementById('toast');
      const toastMsg = document.getElementById('toast-message');
      toastMsg.textContent = message;
      toast.classList.remove('translate-y-20', 'opacity-0');
      toast.classList.add('translate-y-0', 'opacity-100');
      
      setTimeout(() => {
        toast.classList.add('translate-y-20', 'opacity-0');
        toast.classList.remove('translate-y-0', 'opacity-100');
      }, 2500);
    }

    /* Helper: Check URL */
    function isValidUrl(string) {
      try {
        const url = new URL(string);
        return url.protocol === 'http:' || url.protocol === 'https:';
      } catch (_) {
        return false;
      }
    }

    /* Helper: Format Relative Time */
    function formatTime(isoStr) {
      const d = new Date(isoStr);
      return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    }

    function setupTheme() {
      const savedTheme = localStorage.getItem('omniscan_theme') || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
      applyTheme(savedTheme);

      document.getElementById('theme-toggle').addEventListener('click', () => {
        const isDark = document.documentElement.classList.contains('dark');
        const nextTheme = isDark ? 'light' : 'dark';
        applyTheme(nextTheme);
        localStorage.setItem('omniscan_theme', nextTheme);
      });
    }

    function applyTheme(theme) {
      const sunIcon = document.getElementById('theme-icon-sun');
      const moonIcon = document.getElementById('theme-icon-moon');
      if (theme === 'dark') {
        document.documentElement.classList.add('dark');
        sunIcon.classList.remove('hidden');
        moonIcon.classList.add('hidden');
      } else {
        document.documentElement.classList.remove('dark');
        sunIcon.classList.add('hidden');
        moonIcon.classList.remove('dark');
        moonIcon.classList.remove('hidden');
      }
    }

    /* Audio Toggle */
    function setupAudioToggle() {
      const audioBtn = document.getElementById('audio-toggle-btn');
      const audioIcon = document.getElementById('audio-icon');
      audioBtn.addEventListener('click', () => {
        STATE.soundEnabled = !STATE.soundEnabled;
        if (STATE.soundEnabled) {
          audioIcon.setAttribute('data-lucide', 'volume-2');
          showToast('Scan sound enabled');
        } else {
          audioIcon.setAttribute('data-lucide', 'volume-x');
          showToast('Scan sound muted');
        }
        lucide.createIcons();
      });
    }

    async function initCameraDevices() {
      const cameraSelect = document.getElementById('camera-select');
      try {
        const devices = await Html5Qrcode.getCameras();
        STATE.availableCameras = devices || [];
        
        cameraSelect.innerHTML = '';
        if (STATE.availableCameras.length === 0) {
          cameraSelect.innerHTML = '<option value="">No cameras found</option>';
          return;
        }

        STATE.availableCameras.forEach((cam, index) => {
          const opt = document.createElement('option');
          opt.value = cam.id;
          opt.textContent = cam.label || `Camera ${index + 1}`;
          cameraSelect.appendChild(opt);
        });

        // Prefer rear facing camera if available on mobile
        const backCam = STATE.availableCameras.find(c => c.label.toLowerCase().includes('back') || c.label.toLowerCase().includes('environment'));
        if (backCam) {
          STATE.activeCameraId = backCam.id;
          cameraSelect.value = backCam.id;
        } else {
          STATE.activeCameraId = STATE.availableCameras[0].id;
        }
      } catch (err) {
        console.warn('Camera enumeration error or permission denied:', err);
        cameraSelect.innerHTML = '<option value="">Camera access blocked/unavailable</option>';
      }
    }

    async function startScanner() {
      if (STATE.isScanning) return;
      const cameraSelect = document.getElementById('camera-select');
      const selectedCamId = cameraSelect.value;

      if (!selectedCamId && STATE.availableCameras.length > 0) {
        showToast('Please select a valid camera');
        return;
      }

      const idleCover = document.getElementById('scanner-idle');
      const hud = document.getElementById('scan-hud');
      const indicator = document.getElementById('scanner-indicator');
      const statusText = document.getElementById('scanner-status-text');
      const startBtn = document.getElementById('start-btn');
      const stopBtn = document.getElementById('stop-btn');

      try {
        if (!STATE.html5QrCode) {
          STATE.html5QrCode = new Html5Qrcode('qr-reader');
        }

        const config = {
          fps: 15,
          qrbox: (viewWidth, viewHeight) => {
            const minEdge = Math.min(viewWidth, viewHeight);
            const edge = Math.floor(minEdge * 0.72);
            return { width: edge, height: edge };
          },
          aspectRatio: 1.333334
        };

        const cameraIdOrConfig = selectedCamId ? selectedCamId : { facingMode: "environment" };

        await STATE.html5QrCode.start(
          cameraIdOrConfig,
          config,
          onScanSuccess,
          onScanFailure
        );

        STATE.isScanning = true;
        idleCover.classList.add('opacity-0', 'pointer-events-none');
        setTimeout(() => idleCover.classList.add('hidden'), 300);
        hud.classList.remove('hidden');

        indicator.classList.remove('bg-slate-400');
        indicator.classList.add('bg-emerald-500', 'animate-pulse');
        statusText.textContent = 'Active & Scanning';

        startBtn.disabled = true;
        stopBtn.disabled = false;
        
        // Check flashlight capability
        checkTorchCapability();

      } catch (err) {
        console.error('Failed to start scanner:', err);
        showToast('Could not start camera: ' + (err.message || 'Permission denied'));
        indicator.classList.remove('bg-emerald-500', 'animate-pulse');
        indicator.classList.add('bg-rose-500');
        statusText.textContent = 'Camera error';
      }
    }

    async function stopScanner() {
      if (!STATE.isScanning || !STATE.html5QrCode) return;

      const idleCover = document.getElementById('scanner-idle');
      const hud = document.getElementById('scan-hud');
      const indicator = document.getElementById('scanner-indicator');
      const statusText = document.getElementById('scanner-status-text');
      const startBtn = document.getElementById('start-btn');
      const stopBtn = document.getElementById('stop-btn');
      const torchBtn = document.getElementById('torch-btn');

      try {
        await STATE.html5QrCode.stop();
        STATE.isScanning = false;
        torchBtn.classList.add('hidden');

        idleCover.classList.remove('hidden');
        setTimeout(() => idleCover.classList.remove('opacity-0', 'pointer-events-none'), 10);
        hud.classList.add('hidden');

        indicator.classList.remove('bg-emerald-500', 'animate-pulse', 'bg-rose-500');
        indicator.classList.add('bg-slate-400');
        statusText.textContent = 'Stopped';

        startBtn.disabled = false;
        stopBtn.disabled = true;
      } catch (err) {
        console.error('Failed to stop scanner:', err);
      }
    }

    /* Flashlight / Torch check */
    function checkTorchCapability() {
      const torchBtn = document.getElementById('torch-btn');
      try {
        if (STATE.html5QrCode && STATE.html5QrCode.getRunningTrackCameraCapabilities) {
          const capabilities = STATE.html5QrCode.getRunningTrackCameraCapabilities();
          if (capabilities.torchFeature().isSupported()) {
            torchBtn.classList.remove('hidden');
            return;
          }
        }
      } catch (_) {}
      torchBtn.classList.add('hidden');
    }

    function onScanSuccess(decodedText, decodedResult) {
      const now = Date.now();
      // Debounce exact duplicates within 1.5 seconds to avoid spamming
      if (STATE.lastScannedData === decodedText && (now - STATE.lastScannedTimestamp) < 1600) {
        return;
      }

      STATE.lastScannedData = decodedText;
      STATE.lastScannedTimestamp = now;

      // Audio chirp
      playBeep();

      // Vibration on supported mobile devices
      if (navigator.vibrate) {
        navigator.vibrate(80);
      }

      const format = decodedResult?.result?.format?.formatName || 'QR_CODE';
      handleResultData(decodedText, format);
    }

    function onScanFailure(error) {
      // Quiet background polling frames without matches; no action needed
    }

    function handleResultData(text, format = 'QR_CODE') {
      const timestamp = new Date().toISOString();

      // Display in Active Inspector
      document.getElementById('no-result-state').classList.add('hidden');
      const resultContainer = document.getElementById('result-content-container');
      resultContainer.classList.remove('hidden');

      const resultTextEl = document.getElementById('result-text');
      resultTextEl.textContent = text;

      const formatBadge = document.getElementById('result-format-badge');
      formatBadge.textContent = format;
      formatBadge.classList.remove('hidden');

      document.getElementById('result-timestamp').textContent = `Scanned at ${formatTime(timestamp)}`;

      // URL Action Handler
      const openLinkBtn = document.getElementById('open-link-btn');
      if (isValidUrl(text)) {
        openLinkBtn.href = text;
        openLinkBtn.classList.remove('hidden');
      } else {
        openLinkBtn.classList.add('hidden');
      }

      // Add to History
      addToHistory({ text, format, timestamp });
      showToast('Code successfully scanned!');
    }

    function addToHistory(item) {
      // Prevent consecutive duplicate entries in list
      if (STATE.history.length > 0 && STATE.history[0].text === item.text) {
        STATE.history[0].timestamp = item.timestamp;
      } else {
        STATE.history.unshift(item);
        if (STATE.history.length > 50) STATE.history.pop();
      }

      localStorage.setItem('omniscan_history', JSON.stringify(STATE.history));
      renderHistory();
    }

    function renderHistory() {
      const container = document.getElementById('history-list');
      const emptyState = document.getElementById('history-empty');
      const counter = document.getElementById('history-counter');
      
      counter.textContent = STATE.history.length;

      if (STATE.history.length === 0) {
        container.innerHTML = '';
        container.appendChild(emptyState);
        emptyState.classList.remove('hidden');
        return;
      }

      emptyState.classList.add('hidden');
      container.innerHTML = '';

      STATE.history.forEach((entry, idx) => {
        const isUrl = isValidUrl(entry.text);
        const card = document.createElement('div');
        card.className = "p-3 rounded-xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200/60 dark:border-slate-800 hover:border-slate-300 dark:hover:border-slate-700 transition-all flex items-start justify-between gap-3 text-xs";
        
        card.innerHTML = `
          <div class="min-w-0 flex-1">
            <div class="flex items-center space-x-1.5 mb-1 text-[11px] text-slate-400">
              <span class="font-semibold text-slate-600 dark:text-slate-300 uppercase">${escapeHtml(entry.format || 'QR')}</span>
              <span>•</span>
              <span>${formatTime(entry.timestamp)}</span>
            </div>
            <div class="truncate font-mono text-slate-800 dark:text-slate-200 font-medium">${escapeHtml(entry.text)}</div>
          </div>
          <div class="flex items-center space-x-1">
            ${isUrl ? `
              <a href="${escapeHtml(entry.text)}" target="_blank" rel="noopener noreferrer" class="p-1.5 rounded-lg hover:bg-slate-200 dark:hover:bg-slate-700 text-brand-600 dark:text-brand-400 transition-colors" title="Open Link">
                <i data-lucide="external-link" class="w-3.5 h-3.5"></i>
              </a>
            ` : ''}
            <button class="copy-item-btn p-1.5 rounded-lg hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-500 hover:text-slate-700 dark:hover:text-slate-200 transition-colors" data-text="${encodeURIComponent(entry.text)}" title="Copy">
              <i data-lucide="copy" class="w-3.5 h-3.5"></i>
            </button>
          </div>
        `;
        container.appendChild(card);
      });

      // Bind dynamic copy events
      container.querySelectorAll('.copy-item-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
          const text = decodeURIComponent(e.currentTarget.getAttribute('data-text'));
          copyToClipboard(text);
        });
      });

      lucide.createIcons();
    }

    function escapeHtml(str) {
      return (str || '').replace(/[&<>'"]/g, 
        tag => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[tag] || tag)
      );
    }

    /* Clipboard Copy Utility (fallback-safe for iFrames) */
    function copyToClipboard(text) {
      if (!text) return;
      const textArea = document.createElement("textarea");
      textArea.value = text;
      textArea.style.top = "0";
      textArea.style.left = "0";
      textArea.style.position = "fixed";
      textArea.style.opacity = "0";
      document.body.appendChild(textArea);
      textArea.focus();
      textArea.select();
      try {
        const successful = document.execCommand('copy');
        if (successful) {
          showToast('Copied to clipboard!');
        } else {
          showToast('Failed to copy');
        }
      } catch (err) {
        showToast('Copying not supported');
      }
      document.body.removeChild(textArea);
    }

    function setupFileUpload() {
      const fileInput = document.getElementById('qr-file-input');
      const dropLabel = fileInput.parentElement;
      const previewCard = document.getElementById('file-preview-card');
      const fileThumb = document.getElementById('file-thumb');
      const fileName = document.getElementById('file-name');
      const fileMeta = document.getElementById('file-meta');
      const clearBtn = document.getElementById('clear-file-btn');

      // Drag and drop highlights
      ['dragenter', 'dragover'].forEach(name => {
        dropLabel.addEventListener(name, (e) => {
          e.preventDefault();
          e.stopPropagation();
          dropLabel.classList.add('border-brand-500', 'bg-brand-50/50', 'dark:bg-brand-950/40');
        });
      });

      ['dragleave', 'drop'].forEach(name => {
        dropLabel.addEventListener(name, (e) => {
          e.preventDefault();
          e.stopPropagation();
          dropLabel.classList.remove('border-brand-500', 'bg-brand-50/50', 'dark:bg-brand-950/40');
        });
      });

      dropLabel.addEventListener('drop', (e) => {
        if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
          processImageFile(e.dataTransfer.files[0]);
        }
      });

      fileInput.addEventListener('change', (e) => {
        if (e.target.files && e.target.files.length > 0) {
          processImageFile(e.target.files[0]);
        }
      });

      clearBtn.addEventListener('click', () => {
        previewCard.classList.add('hidden');
        fileInput.value = '';
      });

      async function processImageFile(file) {
        if (!file.type.startsWith('image/')) {
          showToast('Please upload a valid image file');
          return;
        }

        // Preview rendering
        fileName.textContent = file.name;
        fileMeta.textContent = `${(file.size / 1024).toFixed(1)} KB • Decoding...`;
        fileThumb.src = URL.createObjectURL(file);
        previewCard.classList.remove('hidden');

        try {
          if (!STATE.html5QrCode) {
            STATE.html5QrCode = new Html5Qrcode('qr-reader');
          }

          // Scan file directly using Html5Qrcode API
          const decodedText = await STATE.html5QrCode.scanFile(file, true);
          fileMeta.textContent = `${(file.size / 1024).toFixed(1)} KB • Decoded successfully`;
          handleResultData(decodedText, 'QR_IMAGE');
        } catch (err) {
          console.error('File scan error:', err);
          fileMeta.textContent = 'No QR code or barcode found in image';
          showToast('No readable QR code found in this image');
        }
      }
    }

    function setupInteractions() {
      // Tab Navigation
      const liveTab = document.getElementById('tab-live');
      const uploadTab = document.getElementById('tab-upload');
      const cameraSection = document.getElementById('camera-section');
      const uploadSection = document.getElementById('upload-section');

      liveTab.addEventListener('click', () => {
        liveTab.className = "flex-1 py-2 px-3.5 rounded-lg text-sm font-semibold flex items-center justify-center space-x-2 transition-all shadow-sm bg-white dark:bg-slate-700 text-slate-900 dark:text-white";
        uploadTab.className = "flex-1 py-2 px-3.5 rounded-lg text-sm font-medium flex items-center justify-center space-x-2 transition-all text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white";
        cameraSection.classList.remove('hidden');
        uploadSection.classList.add('hidden');
      });

      uploadTab.addEventListener('click', () => {
        uploadTab.className = "flex-1 py-2 px-3.5 rounded-lg text-sm font-semibold flex items-center justify-center space-x-2 transition-all shadow-sm bg-white dark:bg-slate-700 text-slate-900 dark:text-white";
        liveTab.className = "flex-1 py-2 px-3.5 rounded-lg text-sm font-medium flex items-center justify-center space-x-2 transition-all text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white";
        uploadSection.classList.remove('hidden');
        cameraSection.classList.add('hidden');
        // Stop camera if user switches to upload tab
        if (STATE.isScanning) {
          stopScanner();
        }
      });

      // Controls
      document.getElementById('start-btn').addEventListener('click', startScanner);
      document.getElementById('stop-btn').addEventListener('click', stopScanner);

      // Flashlight toggle
      document.getElementById('torch-btn').addEventListener('click', async () => {
        try {
          if (STATE.html5QrCode) {
            STATE.torchEnabled = !STATE.torchEnabled;
            await STATE.html5QrCode.applyVideoConstraints({
              advanced: [{ torch: STATE.torchEnabled }]
            });
            showToast(STATE.torchEnabled ? 'Torch On' : 'Torch Off');
          }
        } catch (err) {
          showToast('Torch control error');
        }
      });

      // Copy Active Text
      document.getElementById('copy-result-btn').addEventListener('click', () => {
        const text = document.getElementById('result-text').textContent;
        copyToClipboard(text);
      });

      // Native Share API
      document.getElementById('share-btn').addEventListener('click', () => {
        const text = document.getElementById('result-text').textContent;
        if (navigator.share) {
          navigator.share({
            title: 'Scanned QR Code',
            text: text
          }).catch(() => {});
        } else {
          copyToClipboard(text);
        }
      });

      // Clear History
      document.getElementById('clear-history-btn').addEventListener('click', () => {
        STATE.history = [];
        localStorage.removeItem('omniscan_history');
        renderHistory();
        showToast('History cleared');
      });
    }

    window.addEventListener('DOMContentLoaded', async () => {
      setupTheme();
      setupAudioToggle();
      setupInteractions();
      setupFileUpload();
      renderHistory();
      lucide.createIcons();
      await initCameraDevices();
    });

    // Cleanup on window unload
    window.addEventListener('beforeunload', () => {
      if (STATE.isScanning && STATE.html5QrCode) {
        STATE.html5QrCode.stop().catch(() => {});
      }
    });
