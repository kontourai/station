export const DEV_TEMPLATE_STYLES = `
body{margin:0;font-family:system-ui;background:var(--bg-primary);color:var(--text-primary)}
:root,[data-theme="dark"]{--bg-primary:#1a1a1a;--bg-secondary:#242424;--bg-tertiary:#2a2a2a;--bg-elevated:#333;--bg-hover:#2a2a2a;--bg-highlight:#1e3a5f;--bg-modal:#242424;--bg-input:#1a1a1a;--text-primary:#e0e0e0;--text-secondary:#d0d0d0;--text-muted:#999;--text-tertiary:#9c9c9c;--border-primary:#333;--border-dashed:#444;--accent-primary:#4a9eff;--accent-acp:#22c55e;--color-bg:var(--bg-primary);--color-bg-secondary:var(--bg-secondary);--color-border:var(--border-primary);--color-text:var(--text-primary);--color-text-secondary:var(--text-secondary);--color-primary:var(--accent-primary);--color-bg-hover:var(--bg-hover)}
[data-theme="light"]{--bg-primary:#fff;--bg-secondary:#f5f5f5;--bg-tertiary:#eee;--bg-elevated:#fafafa;--bg-hover:#f0f0f0;--bg-highlight:#e8f0fe;--bg-modal:#fff;--bg-input:#fff;--text-primary:#1a1a1a;--text-secondary:#333;--text-muted:#999;--text-tertiary:#666;--border-primary:#e0e0e0;--border-dashed:#d0d0d0;--accent-primary:#0066cc;--accent-acp:#16a34a;--color-bg:var(--bg-primary);--color-bg-secondary:var(--bg-secondary);--color-border:var(--border-primary);--color-text:var(--text-primary);--color-text-secondary:var(--text-secondary);--color-primary:var(--accent-primary);--color-bg-hover:var(--bg-hover)}
.dev-banner{background:var(--bg-secondary);border-bottom:2px solid var(--border-primary);padding:8px 16px;font-size:13px;display:flex;align-items:center;justify-content:space-between;font-family:monospace}
.dev-banner-left{display:flex;align-items:center;gap:8px}
.dev-banner-name{color:var(--accent-primary);cursor:pointer;font-weight:700;letter-spacing:.02em}
.dev-banner-name:hover{text-decoration:underline}
.dev-banner-sep{color:var(--text-muted);margin:0 2px}
.dev-banner-crumb{color:var(--text-secondary);font-size:12px}
.dev-theme-btn{background:none;border:1px solid var(--border-primary);border-radius:4px;padding:2px 8px;cursor:pointer;font-size:14px;color:var(--text-primary)}
.dev-tabs{display:flex;background:var(--bg-secondary);border-bottom:1px solid var(--border-primary)}
.dev-tab{padding:10px 20px;cursor:pointer;border:none;background:none;color:var(--text-muted);font-size:14px;border-bottom:2px solid transparent;font-family:inherit}
.dev-tab:hover{color:var(--text-primary);background:var(--bg-hover)}
.dev-tab.active{color:var(--accent-primary);border-bottom-color:var(--accent-primary)}
.dev-tab-content{min-height:calc(100vh - 80px)}
.dev-error{padding:2rem;color:#ef4444}
.info-wrap{padding:2rem 2.5rem}
.info-section{margin-bottom:1.5rem}
.info-section-header{display:flex;align-items:center;gap:8px;margin-bottom:8px;padding-bottom:6px;border-bottom:1px solid var(--border-primary)}
.info-section-title{font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--text-muted);font-family:monospace}
.info-section-count{font-size:10px;padding:1px 6px;border-radius:10px;background:var(--bg-tertiary);color:var(--text-muted);font-family:monospace}
.info-empty{color:var(--text-muted);font-size:12px;font-style:italic;padding:6px 12px;font-family:monospace}
.info-top-row{display:flex;gap:1.5rem;margin-bottom:1.5rem;flex-wrap:wrap}
.info-top-col{flex:1;min-width:280px}
.info-layout-card{display:flex;align-items:center;gap:16px;padding:16px 20px;background:var(--bg-secondary);border:1px solid var(--border-primary);border-radius:8px;text-decoration:none;color:var(--text-primary);transition:border-color .15s,background .15s;margin-bottom:6px}
.info-layout-card:hover{border-color:var(--accent-primary);background:var(--bg-hover)}
.info-layout-icon{font-size:1.8rem}
.info-layout-body{flex:1}
.info-layout-name{font-weight:600;font-size:1rem}
.info-layout-meta{font-size:11px;color:var(--text-muted);margin-top:2px;font-family:'SF Mono',Menlo,monospace}
.info-layout-arrow{font-size:1.1rem;color:var(--accent-primary);opacity:0.5;transition:opacity .15s}
.info-layout-card:hover .info-layout-arrow{opacity:1}
.info-card-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:8px}
.info-card{padding:12px 14px;background:var(--bg-secondary);border:1px solid var(--border-primary);border-radius:6px;cursor:pointer;transition:border-color .15s}
.info-card:hover{border-color:var(--accent-primary)}
.info-card-top{display:flex;align-items:center;gap:8px;margin-bottom:4px}
.info-card-icon{font-size:1.1rem}
.info-card-name{font-weight:500;font-size:13px;flex:1}
.info-card-badge{font-size:9px;padding:1px 5px;border-radius:3px;border:1px solid var(--border-primary);color:var(--text-muted);font-family:'SF Mono',Menlo,monospace}
.info-card-sub{font-size:11px;color:var(--text-muted);font-family:'SF Mono',Menlo,monospace}
.info-card-detail{margin-top:8px;padding-top:8px;border-top:1px solid var(--border-primary)}
.info-action-card{display:flex;align-items:center;gap:10px;padding:10px 14px;background:var(--bg-secondary);border:1px solid var(--border-primary);border-radius:6px;margin-bottom:6px}
.info-action-icon{font-size:1rem}
.info-action-body{flex:1;min-width:0}
.info-action-name{font-weight:500;font-size:13px}
.info-action-meta{font-size:11px;color:var(--text-muted);font-family:'SF Mono',Menlo,monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.info-action-badge{font-size:9px;padding:1px 5px;border-radius:3px;border:1px solid var(--border-primary);color:var(--text-muted);font-family:'SF Mono',Menlo,monospace}
.info-item{border:1px solid var(--border-primary);border-radius:6px;margin-bottom:6px;overflow:hidden;background:var(--bg-primary)}
.info-item--open{background:var(--bg-secondary)}
.info-item-header{display:flex;align-items:center;gap:8px;padding:10px 14px;cursor:pointer;user-select:none}
.info-item-header:hover{background:var(--bg-hover)}
.info-item-icon{width:24px;text-align:center;flex-shrink:0}
.info-item-name{flex:1;font-weight:500}
.info-item-badge{font-size:10px;padding:1px 6px;border-radius:3px;border:1px solid var(--border-primary);color:var(--text-muted);font-family:'SF Mono',Menlo,monospace}
.info-item-chevron{color:var(--text-muted);font-size:11px;width:16px;text-align:center}
.info-item-detail{padding:0 14px 14px;border-top:1px solid var(--border-primary)}
.info-kv{display:flex;gap:8px;padding:4px 0;font-size:13px}
.info-kv-key{color:var(--text-muted);min-width:100px;font-family:'SF Mono',Menlo,monospace;font-size:11px}
.info-kv-val{color:var(--text-primary);font-family:'SF Mono',Menlo,monospace;font-size:11px;word-break:break-all}
.info-kv-link{color:var(--accent-primary);text-decoration:none}
.info-kv-link:hover{text-decoration:underline}
.info-kv-source{opacity:0.5;font-style:italic}
.info-prompt-block{margin-top:8px}
.info-prompt-pre{margin:0;padding:12px;background:var(--bg-primary);border:1px solid var(--border-primary);border-radius:4px;font-size:12px;font-family:'SF Mono',Menlo,monospace;white-space:pre-wrap;word-break:break-word;max-height:300px;overflow:auto;color:var(--text-secondary);line-height:1.5}
`;
