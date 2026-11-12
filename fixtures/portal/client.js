const query = selector => document.querySelector(selector);
async function api(path, value) {
  const response = await fetch(path, value === undefined ? {} : {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || data.status || '操作未接纳');
  return data;
}
function notice(value) { query('#notice').textContent = typeof value === 'string' ? value : JSON.stringify(value); }
window.addEventListener('unhandledrejection', event => { event.preventDefault(); notice(event.reason.message); });

class SearchInput extends HTMLElement {
  connectedCallback() {
    this.attachShadow({ mode: 'open' }).innerHTML = '<label>主体名称或税号<input aria-label="主体名称或税号" role="combobox" aria-expanded="false"></label><ul role="listbox"></ul><output></output>';
    const input = this.shadowRoot.querySelector('input');
    let generation = 0, composing = false;
    const search = async () => {
      const current = ++generation;
      const data = await api(`/api/search?q=${encodeURIComponent(input.value)}`);
      if (current !== generation) return;
      const list = this.shadowRoot.querySelector('ul'); list.replaceChildren();
      list.style.cssText='height:120px;overflow:auto;position:relative;padding:0';
      const spacer=document.createElement('div');spacer.style.height=`${data.candidates.length*40}px`;list.append(spacer);
      const render=()=>{
      list.querySelectorAll('[role=option]').forEach(option=>option.remove());
      const start=Math.floor(list.scrollTop/40);
      for (const [index,candidate] of data.candidates.slice(start,start+4).entries()) {
        const option = document.createElement('li'); option.setAttribute('role','option');
        option.style.cssText=`position:absolute;left:0;right:0;height:40px;top:${(start+index)*40}px;list-style:none`;
        option.textContent = `${candidate.name}（${candidate.taxId}）`;
        option.dataset.subject = candidate.id;
        option.onclick = () => {
          input.value = candidate.name; this.shadowRoot.querySelector('output').textContent = candidate.taxId;
          input.setAttribute('aria-expanded','false'); list.replaceChildren();
          this.dispatchEvent(new CustomEvent('chosen',{ detail: candidate,bubbles:true,composed:true }));
        }; list.append(option);
      }
      };list.onscroll=render;render();
      input.setAttribute('aria-expanded','true');
    };
    input.addEventListener('compositionstart',() => { composing = true; });
    input.addEventListener('compositionend',() => { composing = false; search(); });
    input.addEventListener('input',() => { if (!composing) search(); });
  }
}
customElements.define('search-input',SearchInput);
customElements.define('supplier-search',class extends HTMLElement {
  connectedCallback() { this.attachShadow({mode:'open'}).innerHTML = '<search-input></search-input>'; }
});
let selected;
query('supplier-search').addEventListener('chosen',async event => {
  selected = event.detail;
  query('#branch').replaceChildren();
  const data = await api(`/api/branches?subject=${selected.id}`);
  for (const branch of data.values) { const option=document.createElement('option'); option.value=branch.id; option.textContent=branch.name; query('#branch').append(option); }
});
query('#save').onclick = async () => { const result = await api('/api/selection',{subject:selected?.id,branch:query('#branch').value}); query('#result').textContent = JSON.stringify(result); };
notice('名录已连接');
