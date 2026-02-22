import { t } from '../i18n';

export function renderTerms(): string {
  return `
<article class="policy-page">
  <p class="policy-meta">${t('terms.lastUpdated')}</p>
  <h1>${t('terms.title')}</h1>
  <p>${t('terms.intro')}</p>

  <h2>${t('terms.s1.title')}</h2>
  <p>${t('terms.s1.desc')}</p>

  <h2>${t('terms.s2.title')}</h2>
  <p>${t('terms.s2.desc')}</p>

  <h2>${t('terms.s3.title')}</h2>
  <p>${t('terms.s3.desc')}</p>
  <ul>
    <li>${t('terms.s3.item1')}</li>
    <li>${t('terms.s3.item2')}</li>
    <li>${t('terms.s3.item3')}</li>
    <li>${t('terms.s3.item4')}</li>
  </ul>

  <h2>${t('terms.s4.title')}</h2>
  <p><strong>${t('terms.s4.desc1')}</strong></p>
  <p>${t('terms.s4.desc2')}</p>

  <h2>${t('terms.s5.title')}</h2>
  <p>${t('terms.s5.desc')}</p>
  <ul>
    <li>${t('terms.s5.item1')}</li>
    <li>${t('terms.s5.item2')}</li>
    <li>${t('terms.s5.item3')}</li>
    <li>${t('terms.s5.item4')}</li>
  </ul>

  <h2>${t('terms.s6.title')}</h2>
  <p>${t('terms.s6.desc')}</p>

  <h2>${t('terms.s7.title')}</h2>
  <p>${t('terms.s7.desc')}</p>

  <h2>${t('terms.s8.title')}</h2>
  <p>${t('terms.s8.desc')}</p>
  <ul>
    <li>${t('terms.s8.item1')}</li>
    <li>${t('terms.s8.item2')}</li>
    <li>${t('terms.s8.item3')}</li>
    <li>${t('terms.s8.item4')}</li>
    <li>${t('terms.s8.item5')}</li>
    <li>${t('terms.s8.item6')}</li>
  </ul>

  <h2>${t('terms.s9.title')}</h2>
  <p>${t('terms.s9.desc')}</p>

  <h2>${t('terms.s10.title')}</h2>
  <p>${t('terms.s10.desc')}</p>

  <h2>${t('terms.s11.title')}</h2>
  <p>${t('terms.s11.desc')}</p>

  <h2>${t('terms.s12.title')}</h2>
  <p>${t('terms.s12.desc')}</p>

  <h2>${t('terms.s13.title')}</h2>
  <p>${t('terms.s13.desc')}</p>
</article>
`;
}
