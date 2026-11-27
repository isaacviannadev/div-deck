# Fills the page template with the shared favicon/logo and writes docs/index.html.
import pathlib
root = pathlib.Path(__file__).parent
s = (root / 'index.template.html').read_text()
parts = {}
parts['WAITLIST'] = 'mailto:contato@divtecnologia.com.br?subject=Lista%20de%20espera%20DIV%20Deck&amp;body=Ol%C3%A1!%20Quero%20entrar%20na%20lista%20de%20espera%20do%20(MX%20%2F%20Touch%20%2F%20Pro)%3A%20'
parts['WAITLIST_PRO'] = 'mailto:contato@divtecnologia.com.br?subject=Lista%20de%20espera%20DIV%20Deck%20Pro&amp;body=Ol%C3%A1!%20Quero%20saber%20quando%20o%20DIV%20Deck%20Pro%20sair.'
for k, v in parts.items():
    s = s.replace('{{' + k + '}}', v)
(root.parent / 'docs' / 'index.html').write_text(s)
print('docs/index.html written')
