# Fills the page template with the shared favicon/logo and writes docs/index.html.
import pathlib
root = pathlib.Path(__file__).parent
s = (root / 'index.template.html').read_text()
parts = {}
# Public responder URL only. The editor and submitted addresses stay private.
parts['WAITLIST_FORM'] = 'https://docs.google.com/forms/d/e/1FAIpQLSeMSh8MGX-CJnvzyn-OkUhcU3wT5t1bfN-MekAMQI5BoYz0hg/viewform'
for k, v in parts.items():
    s = s.replace('{{' + k + '}}', v)
(root.parent / 'docs' / 'index.html').write_text(s)
print('docs/index.html written')
